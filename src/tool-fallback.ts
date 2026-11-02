import type { Tool, ToolContext } from "./index.ts";

export type ToolFallbackOptions = {
  /** Decide whether a primary-tool error should invoke the fallback. Defaults to true. */
  shouldFallback?: (error: unknown) => boolean;
};

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  throw error;
}

/**
 * Return a tool that tries the primary implementation and invokes the fallback
 * only when the primary throws and shouldFallback accepts the error.
 */
export function withToolFallback(
  primary: Tool,
  fallback: Tool,
  options: ToolFallbackOptions = {},
): Tool {
  const shouldFallback = options.shouldFallback ?? (() => true);
  if (typeof shouldFallback !== "function") {
    throw new TypeError("shouldFallback must be a function");
  }

  return {
    ...primary,
    run: async (input: Record<string, unknown>, context: ToolContext = {}) => {
      try {
        return await primary.run(input, context);
      } catch (error) {
        // Cancellation is control flow, not a dependency failure to recover from.
        throwIfAborted(context.signal);
        if (!shouldFallback(error)) throw error;
        // A predicate may itself trigger cancellation, so check again before fallback.
        throwIfAborted(context.signal);
        return fallback.run(input, context);
      }
    },
  };
}
