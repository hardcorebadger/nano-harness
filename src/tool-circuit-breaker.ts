import type { Tool, ToolContext } from "./index.ts";

export type ToolCircuitBreakerOptions = {
  /** Consecutive counted failures before calls are rejected. Defaults to 5. */
  failureThreshold?: number;
  /** Time the circuit stays open before allowing one probe. Defaults to 30 seconds. */
  resetTimeoutMs?: number;
  /** Classify tool errors; defaults to counting every error. */
  shouldCountFailure?: (error: unknown) => boolean;
};

/** Error returned when a call is rejected by an open circuit. */
export class ToolCircuitOpenError extends Error {
  readonly retryAt: number;

  constructor(retryAt: number) {
    super(`Tool circuit is open; retry after ${new Date(retryAt).toISOString()}`);
    this.name = "ToolCircuitOpenError";
    this.retryAt = retryAt;
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

/**
 * Return an opt-in circuit-breaker wrapper for a tool that depends on an
 * unreliable service. After repeated failures it rejects calls without
 * invoking the tool, then permits one half-open probe after the cooldown.
 */
export function withToolCircuitBreaker(tool: Tool, options: ToolCircuitBreakerOptions = {}): Tool {
  const {
    failureThreshold = 5,
    resetTimeoutMs = 30_000,
    shouldCountFailure = () => true,
  } = options;

  if (!Number.isSafeInteger(failureThreshold) || failureThreshold <= 0) {
    throw new RangeError("failureThreshold must be a positive safe integer");
  }
  if (!Number.isSafeInteger(resetTimeoutMs) || resetTimeoutMs <= 0) {
    throw new RangeError("resetTimeoutMs must be a positive safe integer");
  }
  if (typeof shouldCountFailure !== "function") {
    throw new TypeError("shouldCountFailure must be a function");
  }

  let failures = 0;
  let openedAt: number | undefined;
  let probeInFlight = false;

  const open = (now: number) => {
    openedAt = now;
    probeInFlight = false;
  };
  const close = () => {
    failures = 0;
    openedAt = undefined;
    probeInFlight = false;
  };

  return {
    ...tool,
    run: async (input: Record<string, unknown>, context: ToolContext = {}): Promise<unknown> => {
      throwIfAborted(context.signal);
      let isProbe = false;
      if (openedAt !== undefined) {
        const retryAt = openedAt + resetTimeoutMs;
        if (Date.now() < retryAt) throw new ToolCircuitOpenError(retryAt);
        if (probeInFlight) throw new ToolCircuitOpenError(Date.now() + resetTimeoutMs);
        probeInFlight = true;
        isProbe = true;
      }

      try {
        const result = await tool.run(input, context);
        close();
        return result;
      } catch (error) {
        // Cancellation is not evidence that the dependency failed.
        if (context.signal?.aborted) {
          if (isProbe) probeInFlight = false;
          throw abortReason(context.signal);
        }
        const counted = shouldCountFailure(error);
        if (!counted || !isProbe && openedAt === undefined) {
          if (isProbe || !counted) close();
          if (counted) {
            failures++;
            if (failures >= failureThreshold) open(Date.now());
          }
        } else {
          // A failed half-open probe restarts the full cooldown.
          open(Date.now());
        }
        throw error;
      }
    },
  };
}
