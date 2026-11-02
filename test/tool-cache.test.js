import assert from "node:assert/strict";
import { test } from "node:test";
import { withToolCache } from "../src/tool-cache.ts";

const tool = run => ({ description: "test tool", parameters: { type: "object" }, run });

test("withToolCache reuses successful results for matching inputs", async () => {
  let calls = 0;
  const wrapped = withToolCache(tool(async input => ({ value: input.value, call: ++calls })));

  assert.deepEqual(await wrapped.run({ value: "same" }), { value: "same", call: 1 });
  assert.deepEqual(await wrapped.run({ value: "same" }), { value: "same", call: 1 });
  assert.deepEqual(await wrapped.run({ value: "other" }), { value: "other", call: 2 });
  assert.equal(calls, 2);
});

test("withToolCache expires entries after the configured TTL", async () => {
  const originalNow = Date.now;
  let now = 10_000;
  Date.now = () => now;
  try {
    let calls = 0;
    const wrapped = withToolCache(tool(async () => ++calls), { ttlMs: 50 });
    assert.equal(await wrapped.run({}), 1);
    now += 49;
    assert.equal(await wrapped.run({}), 1);
    now += 1;
    assert.equal(await wrapped.run({}), 2);
  } finally {
    Date.now = originalNow;
  }
});

test("withToolCache evicts the least recently used entry at capacity", async () => {
  const calls = new Map();
  const wrapped = withToolCache(tool(async ({ id }) => {
    calls.set(id, (calls.get(id) ?? 0) + 1);
    return `${id}:${calls.get(id)}`;
  }), { maxEntries: 2 });

  assert.equal(await wrapped.run({ id: "a" }), "a:1");
  assert.equal(await wrapped.run({ id: "b" }), "b:1");
  assert.equal(await wrapped.run({ id: "a" }), "a:1"); // make a the most recently used
  assert.equal(await wrapped.run({ id: "c" }), "c:1"); // evicts b
  assert.equal(await wrapped.run({ id: "b" }), "b:2");
  assert.equal(calls.get("a"), 1);
});

test("withToolCache does not cache failures", async () => {
  let calls = 0;
  const wrapped = withToolCache(tool(async () => {
    if (++calls === 1) throw new Error("temporary failure");
    return "ok";
  }));

  await assert.rejects(wrapped.run({}), /temporary failure/);
  assert.equal(await wrapped.run({}), "ok");
  assert.equal(await wrapped.run({}), "ok");
  assert.equal(calls, 2);
});

test("withToolCache passes context to the tool and rejects aborted cache hits", async () => {
  let receivedSignal;
  const wrapped = withToolCache(tool(async (_input, context) => {
    receivedSignal = context.signal;
    return "cached";
  }));
  const controller = new AbortController();

  assert.equal(await wrapped.run({}, { signal: controller.signal }), "cached");
  assert.equal(receivedSignal, controller.signal);
  controller.abort(new Error("cancelled"));
  await assert.rejects(wrapped.run({}, { signal: controller.signal }), /cancelled/);
});

test("withToolCache validates its options and custom keys", async () => {
  const sample = tool(async () => "ok");
  for (const ttlMs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => withToolCache(sample, { ttlMs }), /ttlMs must be a positive safe integer/);
  }
  for (const maxEntries of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => withToolCache(sample, { maxEntries }), /maxEntries must be a positive safe integer/);
  }
  assert.throws(() => withToolCache(sample, { key: null }), /key must be a function/);

  let calls = 0;
  const keyed = withToolCache(tool(async () => ++calls), { key: input => String(input.id) });
  assert.equal(await keyed.run({ id: 1, ignored: "first" }), 1);
  assert.equal(await keyed.run({ id: 1, ignored: "second" }), 1);
  assert.equal(calls, 1);
});
