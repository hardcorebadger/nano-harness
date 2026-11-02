import type { Tool, ToolContext } from "./index.ts";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type ToolRateLimitOptions = {
  /** Minimum time between starts for calls sharing this wrapped tool. Defaults to 1,000ms. */
  minIntervalMs?: number;
};

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  throwIfAborted(signal);

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
 * Return a tool wrapper that spaces starts by `minIntervalMs`, including when
 * several callers invoke the same wrapped tool concurrently. Tool work itself
 * may overlap; only start times are rate-limited. Waiting is abort-aware.
 */
export function withToolRateLimit(
  tool: Tool,
  options: ToolRateLimitOptions = {},
): Tool {
  const minIntervalMs = options.minIntervalMs ?? 1_000;
  if (
    !Number.isSafeInteger(minIntervalMs) ||
    minIntervalMs < 0 ||
    minIntervalMs > MAX_TIMER_DELAY_MS
  ) {
    throw new RangeError(
      `minIntervalMs must be a non-negative safe integer no greater than ${MAX_TIMER_DELAY_MS}`,
    );
  }

  let lastStartAt = Number.NEGATIVE_INFINITY;
  let queue = Promise.resolve();

  return {
    ...tool,
    run: async (
      input: Record<string, unknown>,
      context: ToolContext = {},
    ): Promise<unknown> => {
      const previous = queue;
      let release!: () => void;
      queue = new Promise<void>((resolve) => {
        release = resolve;
      });

      await previous;
      try {
        throwIfAborted(context.signal);
        const waitMs = Math.max(0, lastStartAt + minIntervalMs - Date.now());
        await delay(waitMs, context.signal);
        throwIfAborted(context.signal);
        lastStartAt = Date.now();
      } finally {
        release();
      }

      return tool.run(input, context);
    },
  };
}
