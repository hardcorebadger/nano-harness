import type { Tool, ToolContext } from "./index.ts";

/**
 * Return a tool wrapper that rejects when the tool exceeds `timeoutMs`.
 * The tool receives a signal that aborts on timeout (and when the parent
 * agent signal aborts), allowing cooperative tools to stop their own work.
 */
export function withToolTimeout(tool: Tool, timeoutMs: number): Tool {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive safe integer");
  }

  return {
    ...tool,
    run: async (input: Record<string, unknown>, context: ToolContext = {}) => {
      if (context.signal?.aborted) {
        throw context.signal.reason ?? new DOMException("The operation was aborted", "AbortError");
      }

      const timeoutController = new AbortController();
      const signals = [timeoutController.signal];
      if (context.signal) signals.push(context.signal);
      const signal = AbortSignal.any(signals);
      const timeoutError = Object.assign(
        new Error(`Tool timed out after ${timeoutMs}ms`),
        { name: "TimeoutError" },
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      let rejectOnAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_, reject) => {
        rejectOnAbort = () => reject(context.signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
        context.signal?.addEventListener("abort", rejectOnAbort, { once: true });
      });
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timeoutController.abort(timeoutError);
          reject(timeoutError);
        }, timeoutMs);
      });

      try {
        const result = Promise.resolve().then(() => tool.run(input, { ...context, signal }));
        return await Promise.race([result, timedOut, aborted]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (rejectOnAbort) context.signal?.removeEventListener("abort", rejectOnAbort);
      }
    },
  };
}
