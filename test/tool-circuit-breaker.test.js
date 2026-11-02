import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolCircuitOpenError, withToolCircuitBreaker } from "../src/tool-circuit-breaker.ts";

const tool = run => ({ description: "test tool", parameters: { type: "object" }, run });

test("withToolCircuitBreaker opens after consecutive failures and permits a half-open probe", async () => {
  const originalNow = Date.now;
  let now = 10_000;
  Date.now = () => now;
  try {
    let calls = 0;
    let fail = true;
    const wrapped = withToolCircuitBreaker(tool(async () => {
      calls++;
      if (fail) throw new Error("service unavailable");
      return "ok";
    }), { failureThreshold: 2, resetTimeoutMs: 100 });

    await assert.rejects(wrapped.run({}), /service unavailable/);
    await assert.rejects(wrapped.run({}), /service unavailable/);
    await assert.rejects(wrapped.run({}), error => {
      assert.ok(error instanceof ToolCircuitOpenError);
      assert.equal(error.retryAt, 10_200);
      return true;
    });
    assert.equal(calls, 2);

    now += 100;
    fail = false;
    assert.equal(await wrapped.run({}), "ok");
    assert.equal(await wrapped.run({}), "ok");
    assert.equal(calls, 4);
  } finally {
    Date.now = originalNow;
  }
});

test("withToolCircuitBreaker resets consecutive failures after success", async () => {
  let fail = true;
  let calls = 0;
  const wrapped = withToolCircuitBreaker(tool(async () => {
    calls++;
    if (fail) throw new Error("temporary");
    return "ok";
  }), { failureThreshold: 2 });

  await assert.rejects(wrapped.run({}), /temporary/);
  fail = false;
  assert.equal(await wrapped.run({}), "ok");
  fail = true;
  await assert.rejects(wrapped.run({}), /temporary/);
  await assert.rejects(wrapped.run({}), /temporary/);
  assert.equal(calls, 4);
  await assert.rejects(wrapped.run({}), ToolCircuitOpenError);
});

test("withToolCircuitBreaker allows only one simultaneous half-open probe", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    let calls = 0;
    let rejectProbe;
    const wrapped = withToolCircuitBreaker(tool(() => {
      calls++;
      if (calls === 1) throw new Error("down");
      return new Promise((_, reject) => { rejectProbe = reject; });
    }), { failureThreshold: 1, resetTimeoutMs: 25 });

    await assert.rejects(wrapped.run({}), /down/);
    now += 25;
    const probe = wrapped.run({});
    await Promise.resolve();
    await assert.rejects(wrapped.run({}), ToolCircuitOpenError);
    assert.equal(calls, 2);
    rejectProbe(new Error("still down"));
    await assert.rejects(probe, /still down/);
  } finally {
    Date.now = originalNow;
  }
});

test("withToolCircuitBreaker ignores uncounted errors and caller cancellation", async () => {
  let calls = 0;
  const wrapped = withToolCircuitBreaker(tool(async () => {
    calls++;
    throw new Error("input rejected");
  }), { failureThreshold: 1, shouldCountFailure: error => !error.message.includes("input") });

  await assert.rejects(wrapped.run({}), /input rejected/);
  await assert.rejects(wrapped.run({}), /input rejected/);
  assert.equal(calls, 2);

  const controller = new AbortController();
  const reason = new Error("cancelled");
  controller.abort(reason);
  await assert.rejects(wrapped.run({}, { signal: controller.signal }), error => error === reason);
  assert.equal(calls, 2);
});

test("withToolCircuitBreaker validates options", () => {
  const sample = tool(async () => "ok");
  for (const failureThreshold of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => withToolCircuitBreaker(sample, { failureThreshold }), /failureThreshold must be a positive safe integer/);
  }
  for (const resetTimeoutMs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => withToolCircuitBreaker(sample, { resetTimeoutMs }), /resetTimeoutMs must be a positive safe integer/);
  }
  assert.throws(() => withToolCircuitBreaker(sample, { shouldCountFailure: null }), /shouldCountFailure must be a function/);
});
