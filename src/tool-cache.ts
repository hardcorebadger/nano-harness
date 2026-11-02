import type { Tool, ToolContext } from "./index.ts";

export type ToolCacheOptions = {
  /** How long successful results stay cached. Defaults to 30 seconds. */
  ttlMs?: number;
  /** Maximum number of entries retained. Defaults to 100. */
  maxEntries?: number;
  /** Build a cache key from tool input. Defaults to JSON.stringify(input). */
  key?: (input: Record<string, unknown>) => string;
};

type CacheEntry = { value: unknown; expiresAt: number };

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

/**
 * Return an opt-in TTL/LRU cache wrapper for a read-only, cacheable tool.
 * Only successful results are cached; callers should avoid wrapping tools
 * whose results depend on context not represented in the cache key.
 */
export function withToolCache(tool: Tool, options: ToolCacheOptions = {}): Tool {
  const { ttlMs = 30_000, maxEntries = 100, key = input => JSON.stringify(input) } = options;

  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new RangeError("ttlMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new RangeError("maxEntries must be a positive safe integer");
  }
  if (typeof key !== "function") throw new TypeError("key must be a function");

  const cache = new Map<string, CacheEntry>();

  return {
    ...tool,
    run: async (input: Record<string, unknown>, context: ToolContext = {}): Promise<unknown> => {
      throwIfAborted(context.signal);
      const cacheKey = key(input);
      if (typeof cacheKey !== "string") throw new TypeError("key must return a string");

      const now = Date.now();
      const cached = cache.get(cacheKey);
      if (cached && cached.expiresAt > now) {
        // Refresh insertion order so frequently used values stay in the LRU.
        cache.delete(cacheKey);
        cache.set(cacheKey, cached);
        return cached.value;
      }
      if (cached) cache.delete(cacheKey);

      const value = await tool.run(input, context);
      throwIfAborted(context.signal);

      const storedAt = Date.now();
      for (const [entryKey, entry] of cache) {
        if (entry.expiresAt <= storedAt) cache.delete(entryKey);
      }
      while (cache.size >= maxEntries) {
        const oldestKey = cache.keys().next().value as string | undefined;
        if (oldestKey === undefined) break;
        cache.delete(oldestKey);
      }
      cache.set(cacheKey, { value, expiresAt: storedAt + ttlMs });
      return value;
    },
  };
}
