import assert from "node:assert/strict";
import { test } from "node:test";
import { withToolConcurrencyLimit } from "../src/tool-concurrency-limit.ts";

const tool = run => ({ description: "test tool", parameters: { type: "object" }, run });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
};

test("withToolConcurrencyLimit bounds active calls and releases queued work FIFO", async () => {
  const starts = [];
  const finishes = new Map();
  let active = 0;
  let peak = 0;
  const started = [];
  const wrapped = withToolConcurrencyLimit(tool(async ({ value }) => {
    starts.push(value);
    active++;
    peak = Math.max(peak, active);
    const signal = deferred();
    finishes.set(value, signal);
    started.shift()?.resolve();
    await signal.promise;
    active--;
    return value;
  }), 2);

  const waitForStart = () => {
    const signal = deferred();
    started.push(signal);
    return signal.promise;
  };
  const firstStart = waitForStart();
  const first = wrapped.run({ value: "first" });
  await firstStart;
  const secondStart = waitForStart();
  const second = wrapped.run({ value: "second" });
  await secondStart;
  const thirdStart = waitForStart();
  const third = wrapped.run({ value: "third" });

  assert.deepEqual(starts, ["first", "second"]);
  finishes.get("first").resolve();
  await thirdStart;
  assert.deepEqual(starts, ["first", "second", "third"]);
  assert.equal(peak, 2);

  finishes.get("second").resolve();
  finishes.get("third").resolve();
  assert.deepEqual(await Promise.all([first, second, third]), ["first", "second", "third"]);
});

test("withToolConcurrencyLimit aborts a queued call without invoking the tool", async () => {
  const started = deferred();
  const finish = deferred();
  const calls = [];
  const wrapped = withToolConcurrencyLimit(tool(async ({ value }) => {
    calls.push(value);
    started.resolve();
    await finish.promise;
    return value;
  }), 1);

  const first = wrapped.run({ value: "first" });
  await started.promise;
  const controller = new AbortController();
  const reason = new Error("cancel queued call");
  const second = wrapped.run({ value: "second" }, { signal: controller.signal });
  controller.abort(reason);

  await assert.rejects(second, error => error === reason);
  assert.deepEqual(calls, ["first"]);
  finish.resolve();
  assert.equal(await first, "first");
});

test("withToolConcurrencyLimit validates the concurrency limit", () => {
  for (const maxConcurrent of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => withToolConcurrencyLimit(tool(async () => null), maxConcurrent),
      /maxConcurrent must be a positive safe integer/,
    );
  }
  assert.doesNotThrow(() => withToolConcurrencyLimit(tool(async () => null), 1));
});
