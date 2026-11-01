import type { Tool } from "./index.ts";

/** JSON Schema keywords supported by this lightweight runtime validator. */
type Schema = Record<string, unknown>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesType(value: unknown, expected: unknown): boolean {
  const types = Array.isArray(expected) ? expected : [expected];
  const actual = typeOf(value);
  return types.some((type) => type === actual || (type === "number" && actual === "integer"));
}

function equalJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => equalJson(item, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    return aKeys.length === bKeys.length && aKeys.every((key, i) => key === bKeys[i] && equalJson(a[key], b[key]));
  }
  return false;
}

function validate(value: unknown, schema: Schema, path: string, depth = 0): string | undefined {
  if (depth > 64) return `${path} exceeds the maximum schema validation depth`;
  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    const expected = Array.isArray(schema.type) ? schema.type.join(" or ") : String(schema.type);
    return `${path} must be ${expected}`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => equalJson(value, item))) {
    return `${path} must be one of the declared enum values`;
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return `${path} must have at least ${schema.minLength} characters`;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return `${path} must have at most ${schema.maxLength} characters`;
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) return `${path} does not match the required pattern`;
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return `${path} must be at least ${schema.minimum}`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `${path} must be at most ${schema.maximum}`;
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) return `${path} must be greater than ${schema.exclusiveMinimum}`;
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) return `${path} must be less than ${schema.exclusiveMaximum}`;
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return `${path} must contain at least ${schema.minItems} items`;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `${path} must contain at most ${schema.maxItems} items`;
    if (isObject(schema.items)) {
      for (let i = 0; i < value.length; i++) {
        const error = validate(value[i], schema.items as Schema, `${path}[${i}]`, depth + 1);
        if (error) return error;
      }
    }
  }

  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const name of schema.required) {
        if (typeof name === "string" && !Object.hasOwn(value, name)) return `${path}.${name} is required`;
      }
    }
    for (const [name, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, name) && isObject(child)) {
        const error = validate(value[name], child as Schema, `${path}.${name}`, depth + 1);
        if (error) return error;
      }
    }
    if (schema.additionalProperties === false) {
      const unexpected = Object.keys(value).find((name) => !Object.hasOwn(properties, name));
      if (unexpected) return `${path}.${unexpected} is not allowed`;
    }
  }
  return undefined;
}

/** Thrown before a tool runs when its arguments do not match its declared schema. */
export class ToolArgumentValidationError extends Error {
  constructor(message: string) {
    super(`Invalid tool arguments: ${message}`);
    this.name = "ToolArgumentValidationError";
  }
}

/**
 * Wrap a tool to check parsed arguments against its declared JSON Schema before
 * any tool code runs. Supports type, enum, required, properties,
 * additionalProperties:false, string length/pattern, numeric bounds, and array
 * items/length constraints. Validation is intentionally opt-in and dependency-free.
 */
export function withToolValidation(tool: Tool): Tool {
  return {
    ...tool,
    run: async (input, context) => {
      const error = validate(input, tool.parameters, "$", 0);
      if (error) throw new ToolArgumentValidationError(error);
      return tool.run(input, context);
    },
  };
}
