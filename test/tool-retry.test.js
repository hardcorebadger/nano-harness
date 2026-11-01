import assert from "node:assert/strict";
import { test } from "node:test";
import { withToolRetry } from "../src/tool-retry.ts";

const tool = run => ({ description: "test tool", parameters: { type: "object" }, run });

test("withToolRetry retries failures and returns the eventual result", async () => {
  let calls = 0;
  const input = { id: 7 };
  const wrapped = withToolRetry(tool(async received => {
    assert.equal(received, input);
    calls++;
    if (calls < 3) throw new Error("temporary");
    return "ok";
  }), { maxAttempts: 3, initialDelayMs: 0 });

  assert.equal(await wrapped.run(input), "ok");
  assert.equal(calls, 3);
});

test("withToolRetry stops after maxAttempts and rethrows the last error", async () => {
  let calls = 0;
  const failure = new Error("unavailable");
  const wrapped = withToolRetry(tool(() => {
    calls++;
    throw failure;
  }), { maxAttempts: 2, initialDelayMs: 0 });

  await assert.rejects(wrapped.run({}), error => error === failure);
  assert.equal(calls, 2);
});

test("withToolRetry honors shouldRetry", async () => {
  let calls = 0;
  const permanent = new Error("bad input");
  const wrapped = withToolRetry(tool(() => {
    calls++;
    throw permanent;
  }), {
    maxAttempts: 4,
    initialDelayMs: 0,
    shouldRetry: error => error.message !== "bad input",
  });

  await assert.rejects(wrapped.run({}), error => error === permanent);
  assert.equal(calls, 1);
});

test("withToolRetry passes through the tool context and parent signal", async () => {
  const controller = new AbortController();
  const context = { signal: controller.signal };
  let receivedContext;
  const wrapped = withToolRetry(tool((_, received) => {
    receivedContext = received;
    return "ok";
  }), { initialDelayMs: 0 });

  assert.equal(await wrapped.run({}, context), "ok");
  assert.equal(receivedContext, context);
});

test("withToolRetry cancellation aborts an in-flight tool promptly", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled");
  let calls = 0;
  const wrapped = withToolRetry(tool(() => {
    calls++;
    return new Promise(() => {});
  }), { maxAttempts: 3, initialDelayMs: 0 });
  const run = wrapped.run({}, { signal: controller.signal });
  controller.abort(reason);

  await assert.rejects(run, error => error === reason);
  assert.equal(calls, 1);
});

test("withToolRetry cancellation during backoff prevents another attempt", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled during backoff");
  let calls = 0;
  const wrapped = withToolRetry(tool(() => {
    calls++;
    throw new Error("temporary");
  }), { maxAttempts: 3, initialDelayMs: 1000 });
  const run = wrapped.run({}, { signal: controller.signal });
  setTimeout(() => controller.abort(reason), 5);

  await assert.rejects(run, error => error === reason);
  assert.equal(calls, 1);
});

test("withToolRetry rejects invalid retry settings", () => {
  const sample = tool(() => null);
  assert.throws(() => withToolRetry(sample, { maxAttempts: 0 }), /maxAttempts must be a positive safe integer/);
  assert.throws(() => withToolRetry(sample, { initialDelayMs: -1 }), /initialDelayMs must be a non-negative safe integer/);
  assert.throws(() => withToolRetry(sample, { maxDelayMs: 50, initialDelayMs: 100 }), /maxDelayMs must be a safe integer/);
  assert.throws(() => withToolRetry(sample, { backoffFactor: 0.5 }), /backoffFactor must be a finite number/);
});
