import type { Tool, ToolContext } from "./index.ts";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type ToolRetryOptions = {
  /** Total calls including the first attempt. Defaults to 3. */
  maxAttempts?: number;
  /** Delay before the second attempt. Defaults to 100ms. */
  initialDelayMs?: number;
  /** Upper bound for exponential backoff. Defaults to 5 seconds. */
  maxDelayMs?: number;
  /** Multiplier applied after each failed attempt. Defaults to 2. */
  backoffFactor?: number;
  /** Decide whether a thrown error should be retried. Defaults to retrying all errors. */
  shouldRetry?: (error: unknown, failedAttempt: number) => boolean;
};

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function runWithAbort<T>(run: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return Promise.resolve().then(run);

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  const result = Promise.resolve().then(run);
  return Promise.race([result, aborted]).finally(() => {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  });
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (ms === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal!));
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/**
 * Return an opt-in retry wrapper for an idempotent tool. Thrown errors are
 * retried by default; use `shouldRetry` to exclude permanent failures.
 */
export function withToolRetry(tool: Tool, options: ToolRetryOptions = {}): Tool {
  const {
    maxAttempts = 3,
    initialDelayMs = 100,
    maxDelayMs = 5_000,
    backoffFactor = 2,
    shouldRetry = () => true,
  } = options;

  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
    throw new RangeError("maxAttempts must be a positive safe integer");
  }
  if (!Number.isSafeInteger(initialDelayMs) || initialDelayMs < 0 || initialDelayMs > MAX_TIMER_DELAY_MS) {
    throw new RangeError("initialDelayMs must be a non-negative safe integer within the timer limit");
  }
  if (!Number.isSafeInteger(maxDelayMs) || maxDelayMs < initialDelayMs || maxDelayMs > MAX_TIMER_DELAY_MS) {
    throw new RangeError("maxDelayMs must be a safe integer at least initialDelayMs and within the timer limit");
  }
  if (!Number.isFinite(backoffFactor) || backoffFactor < 1) {
    throw new RangeError("backoffFactor must be a finite number greater than or equal to 1");
  }
  if (typeof shouldRetry !== "function") {
    throw new TypeError("shouldRetry must be a function");
  }

  return {
    ...tool,
    run: async (input: Record<string, unknown>, context: ToolContext = {}) => {
      for (let attempt = 1; ; attempt++) {
        throwIfAborted(context.signal);
        try {
          return await runWithAbort(() => tool.run(input, context), context.signal);
        } catch (error) {
          throwIfAborted(context.signal);
          if (attempt >= maxAttempts || !shouldRetry(error, attempt)) throw error;
          const backoffMs = Math.min(maxDelayMs, initialDelayMs * backoffFactor ** (attempt - 1));
          await delay(backoffMs, context.signal);
        }
      }
    },
  };
}
