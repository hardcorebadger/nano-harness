import type { Tool, ToolContext } from "./index.ts";

/** A snapshot of calls made through one metrics-wrapped tool instance. */
export type ToolMetrics = {
  calls: number;
  succeeded: number;
  failed: number;
  inFlight: number;
  totalDurationMs: number;
  averageDurationMs: number;
  lastDurationMs: number;
  maxDurationMs: number;
};

/** A tool wrapper that also exposes a fresh metrics snapshot on demand. */
export type ToolWithMetrics = Tool & {
  getMetrics(): ToolMetrics;
};

/**
 * Wrap a tool and collect per-instance call counts and elapsed durations.
 * Metrics are local to this wrapper; no global state or external reporter is used.
 */
export function withToolMetrics(tool: Tool): ToolWithMetrics {
  let calls = 0;
  let succeeded = 0;
  let failed = 0;
  let inFlight = 0;
  let totalDurationMs = 0;
  let lastDurationMs = 0;
  let maxDurationMs = 0;

  return {
    ...tool,
    run: async (
      input: Record<string, unknown>,
      context: ToolContext = {},
    ): Promise<unknown> => {
      calls++;
      inFlight++;
      const startedAt = Date.now();

      try {
        const result = await tool.run(input, context);
        succeeded++;
        return result;
      } catch (error) {
        failed++;
        throw error;
      } finally {
        lastDurationMs = Math.max(0, Date.now() - startedAt);
        totalDurationMs += lastDurationMs;
        maxDurationMs = Math.max(maxDurationMs, lastDurationMs);
        inFlight--;
      }
    },
    getMetrics: (): ToolMetrics => ({
      calls,
      succeeded,
      failed,
      inFlight,
      totalDurationMs,
      averageDurationMs: calls === 0 ? 0 : totalDurationMs / calls,
      lastDurationMs,
      maxDurationMs,
    }),
  };
}
