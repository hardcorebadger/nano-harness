import assert from "node:assert/strict";
import { test } from "node:test";
import { withToolMetrics } from "../src/tool-metrics.ts";

const tool = run => ({
  description: "test tool",
  parameters: { type: "object" },
  run,
});

test("withToolMetrics starts with an empty snapshot and preserves tool behavior", async () => {
  let received;
  const source = tool(async (input, context) => {
    received = { input, context };
    return "ok";
  });
  source.always = true;
  const wrapped = withToolMetrics(source);

  assert.equal(wrapped.description, source.description);
  assert.equal(wrapped.always, true);
  assert.deepEqual(wrapped.getMetrics(), {
    calls: 0,
    succeeded: 0,
    failed: 0,
    inFlight: 0,
    totalDurationMs: 0,
    averageDurationMs: 0,
    lastDurationMs: 0,
    maxDurationMs: 0,
  });

  const input = { id: "abc" };
  const context = { signal: new AbortController().signal };
  assert.equal(await wrapped.run(input, context), "ok");
  assert.deepEqual(received, { input, context });
  assert.deepEqual(wrapped.getMetrics(), {
    calls: 1,
    succeeded: 1,
    failed: 0,
    inFlight: 0,
    totalDurationMs: wrapped.getMetrics().totalDurationMs,
    averageDurationMs: wrapped.getMetrics().totalDurationMs,
    lastDurationMs: wrapped.getMetrics().lastDurationMs,
    maxDurationMs: wrapped.getMetrics().lastDurationMs,
  });
});

test("withToolMetrics counts failures and preserves the original error", async () => {
  const failure = new Error("offline");
  const wrapped = withToolMetrics(tool(async () => {
    throw failure;
  }));

  await assert.rejects(wrapped.run({}), error => error === failure);
  assert.deepEqual(wrapped.getMetrics(), {
    calls: 1,
    succeeded: 0,
    failed: 1,
    inFlight: 0,
    totalDurationMs: wrapped.getMetrics().totalDurationMs,
    averageDurationMs: wrapped.getMetrics().totalDurationMs,
    lastDurationMs: wrapped.getMetrics().lastDurationMs,
    maxDurationMs: wrapped.getMetrics().lastDurationMs,
  });
});

test("withToolMetrics reports concurrent in-flight calls and returns snapshots", async () => {
  let finishFirst;
  let finishSecond;
  const wrapped = withToolMetrics(tool(() => new Promise(resolve => {
    if (!finishFirst) finishFirst = resolve;
    else finishSecond = resolve;
  })));

  const first = wrapped.run({ call: 1 });
  const second = wrapped.run({ call: 2 });
  assert.equal(wrapped.getMetrics().inFlight, 2);
  assert.equal(wrapped.getMetrics().calls, 2);
  assert.equal(wrapped.getMetrics().succeeded, 0);

  finishFirst("first");
  assert.equal(await first, "first");
  assert.equal(wrapped.getMetrics().inFlight, 1);
  finishSecond("second");
  assert.equal(await second, "second");

  const snapshot = wrapped.getMetrics();
  assert.equal(snapshot.calls, 2);
  assert.equal(snapshot.succeeded, 2);
  assert.equal(snapshot.failed, 0);
  assert.equal(snapshot.inFlight, 0);
  assert.ok(snapshot.totalDurationMs >= 0);
  assert.ok(snapshot.averageDurationMs >= 0);
  assert.ok(snapshot.maxDurationMs >= snapshot.lastDurationMs);
});
