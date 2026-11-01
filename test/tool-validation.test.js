import assert from "node:assert/strict";
import test from "node:test";
import { ToolArgumentValidationError, withToolValidation } from "../src/tool-validation.ts";

const schema = {
  type: "object",
  properties: {
    query: { type: "string", minLength: 2 },
    limit: { type: "integer", minimum: 1, maximum: 10 },
    tags: { type: "array", items: { type: "string", enum: ["red", "blue"] } },
  },
  required: ["query"],
  additionalProperties: false,
};

test("withToolValidation allows valid input and forwards it and context", async () => {
  const context = { signal: new AbortController().signal };
  let received;
  const wrapped = withToolValidation({
    description: "Search",
    parameters: schema,
    run: async (input, runContext) => {
      received = { input, runContext };
      return ["ok"];
    },
  });

  assert.deepEqual(await wrapped.run({ query: "hi", limit: 3, tags: ["red"] }, context), ["ok"]);
  assert.deepEqual(received, { input: { query: "hi", limit: 3, tags: ["red"] }, runContext: context });
});

test("withToolValidation rejects missing, mistyped, and out-of-range values before running", async () => {
  let calls = 0;
  const wrapped = withToolValidation({
    description: "Search",
    parameters: schema,
    run: () => { calls++; return "should not run"; },
  });

  for (const input of [{}, { query: "x" }, { query: "valid", limit: 11 }, { query: "valid", tags: ["green"] }, { query: "valid", extra: true }]) {
    await assert.rejects(() => wrapped.run(input), (error) => error instanceof ToolArgumentValidationError);
  }
  assert.equal(calls, 0);
});

test("enum comparison handles equivalent nested JSON objects", async () => {
  const wrapped = withToolValidation({
    description: "Select",
    parameters: { type: "object", properties: { choice: { enum: [{ a: 1, b: [true] }] } }, required: ["choice"] },
    run: (input) => input,
  });

  assert.deepEqual(await wrapped.run({ choice: { b: [true], a: 1 } }), { choice: { b: [true], a: 1 } });
});
