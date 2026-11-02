import type { Tool, ToolContext } from "./index.ts";

type Waiter = {
  signal?: AbortSignal;
  queued: boolean;
  grant: () => void;
  abort: () => void;
};

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}

/**
 * Return a tool wrapper that permits at most `maxConcurrent` active calls.
 * Additional calls wait FIFO for a slot; queued calls honor the agent's abort
 * signal and never invoke the tool when cancelled.
 */
export function withToolConcurrencyLimit(tool: Tool, maxConcurrent: number): Tool {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent <= 0) {
    throw new RangeError("maxConcurrent must be a positive safe integer");
  }

  let active = 0;
  const queue: Waiter[] = [];

  const release = () => {
    active--;
    while (queue.length) {
      const waiter = queue.shift()!;
      if (!waiter.queued) continue;
      if (waiter.signal?.aborted) {
        waiter.abort();
        continue;
      }
      waiter.grant();
      return;
    }
  };

  const acquire = (signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (active < maxConcurrent && queue.length === 0) {
      active++;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      let waiter!: Waiter;
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      const onAbort = () => {
        if (!waiter.queued) return;
        waiter.queued = false;
        const index = queue.indexOf(waiter);
        if (index !== -1) queue.splice(index, 1);
        cleanup();
        reject(abortReason(signal!));
      };
      waiter = {
        signal,
        queued: true,
        grant: () => {
          if (!waiter.queued) return;
          if (signal?.aborted) {
            onAbort();
            return;
          }
          waiter.queued = false;
          cleanup();
          active++;
          resolve();
        },
        abort: onAbort,
      };
      queue.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  };

  return {
    ...tool,
    run: async (input: Record<string, unknown>, context: ToolContext = {}): Promise<unknown> => {
      await acquire(context.signal);
      try {
        return await tool.run(input, context);
      } finally {
        release();
      }
    },
  };
}
