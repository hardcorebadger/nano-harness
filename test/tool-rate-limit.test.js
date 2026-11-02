import assert from "node:assert/strict";
import { test } from "node:test";
import { withToolRateLimit } from "../src/tool-rate-limit.ts";

const tool = run => ({
  description: "test tool",
  parameters: { type: "object" },
  run,
});

test("withToolRateLimit spaces concurrent tool starts and preserves results", async () => {
  const starts = [];
  const wrapped = withToolRateLimit(
    tool(async ({ value }) => {
      starts.push(Date.now());
      return value;
    }),
    { minIntervalMs: 25 },
  );

  assert.deepEqual(
    await Promise.all([
      wrapped.run({ value: "first" }),
      wrapped.run({ value: "second" }),
      wrapped.run({ value: "third" }),
    ]),
    ["first", "second", "third"],
  );
  assert.equal(starts.length, 3);
  assert.ok(starts[1] - starts[0] >= 20);
  assert.ok(starts[2] - starts[1] >= 20);
});

test("withToolRateLimit aborts a queued call before invoking the tool", async () => {
  let started;
  let finishFirst;
  const firstStarted = new Promise(resolve => {
    started = resolve;
  });
  const firstWork = new Promise(resolve => {
    finishFirst = resolve;
  });
  const calls = [];
  const wrapped = withToolRateLimit(
    tool(async ({ value }) => {
      calls.push(value);
      if (value === "first") started();
      if (value === "first") await firstWork;
      return value;
    }),
    { minIntervalMs: 200 },
  );

  const first = wrapped.run({ value: "first" });
  await firstStarted;
  const controller = new AbortController();
  const reason = new Error("cancel queued call");
  const second = wrapped.run({ value: "second" }, { signal: controller.signal });
  controller.abort(reason);

  await assert.rejects(second, error => error === reason);
  assert.deepEqual(calls, ["first"]);
  finishFirst();
  assert.equal(await first, "first");
});

test("withToolRateLimit validates the interval", () => {
  for (const minIntervalMs of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, 2_147_483_648]) {
    assert.throws(
      () => withToolRateLimit(tool(async () => null), { minIntervalMs }),
      /minIntervalMs must be a non-negative safe integer/,
    );
  }
  assert.doesNotThrow(() => withToolRateLimit(tool(async () => null), { minIntervalMs: 0 }));
});
