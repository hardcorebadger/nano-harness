import assert from "node:assert/strict";
import test from "node:test";
import { withToolFallback } from "../src/tool-fallback.ts";

const tool = (run, extra = {}) => ({
  description: "Look up a record",
  parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  run,
  ...extra,
});

test("withToolFallback returns the primary result and forwards input/context", async () => {
  const context = { signal: new AbortController().signal };
  const input = { id: "r-1" };
  let primaryArgs;
  let fallbackCalls = 0;
  const wrapped = withToolFallback(
    tool(async (received, receivedContext) => {
      primaryArgs = [received, receivedContext];
      return { source: "primary" };
    }, { always: true }),
    tool(() => { fallbackCalls++; return { source: "fallback" }; }),
  );

  assert.deepEqual(await wrapped.run(input, context), { source: "primary" });
  assert.deepEqual(primaryArgs, [input, context]);
  assert.equal(fallbackCalls, 0);
  assert.equal(wrapped.always, true);
  assert.equal(wrapped.parameters.type, "object");
});

test("withToolFallback invokes the fallback after a primary failure with same input/context", async () => {
  const context = { signal: new AbortController().signal };
  const input = { id: "r-2" };
  const failure = new Error("primary unavailable");
  let fallbackArgs;
  const wrapped = withToolFallback(
    tool(() => { throw failure; }),
    tool(async (received, receivedContext) => {
      fallbackArgs = [received, receivedContext];
      return { source: "fallback" };
    }),
  );

  assert.deepEqual(await wrapped.run(input, context), { source: "fallback" });
  assert.deepEqual(fallbackArgs, [input, context]);
});

test("withToolFallback can exclude errors and rethrows the original error", async () => {
  const failure = new TypeError("bad input");
  let fallbackCalls = 0;
  const wrapped = withToolFallback(
    tool(() => { throw failure; }),
    tool(() => { fallbackCalls++; return "fallback"; }),
    { shouldFallback: error => !(error instanceof TypeError) },
  );

  await assert.rejects(() => wrapped.run({ id: "r-3" }), error => error === failure);
  assert.equal(fallbackCalls, 0);
});

test("withToolFallback never treats an aborted primary call as recoverable", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled");
  let fallbackCalls = 0;
  const wrapped = withToolFallback(
    tool(() => {
      controller.abort(reason);
      throw new Error("request interrupted");
    }),
    tool(() => { fallbackCalls++; return "fallback"; }),
  );

  await assert.rejects(() => wrapped.run({ id: "r-4" }, { signal: controller.signal }), error => error === reason);
  assert.equal(fallbackCalls, 0);
});

test("withToolFallback propagates fallback errors unchanged", async () => {
  const fallbackError = new Error("fallback unavailable");
  const wrapped = withToolFallback(
    tool(() => { throw new Error("primary unavailable"); }),
    tool(() => { throw fallbackError; }),
  );

  await assert.rejects(() => wrapped.run({ id: "r-5" }), error => error === fallbackError);
});

test("withToolFallback validates its predicate option", () => {
  assert.throws(() => withToolFallback(tool(() => null), tool(() => null), { shouldFallback: true }), /shouldFallback must be a function/);
});
