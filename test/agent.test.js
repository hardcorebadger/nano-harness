import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { agent } from "../src/index.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const searchToolsTurn = () => new Response(JSON.stringify({
  choices: [{
    message: {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call-search",
        type: "function",
        function: { name: "search_tools", arguments: '{"query":""}' },
      }],
    },
  }],
}), { headers: { "content-type": "application/json" } });

test("maxSteps controls the model turn limit", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return searchToolsTurn();
  };

  await assert.rejects(
    agent("keep going", {}, undefined, undefined, {}, undefined, undefined, undefined, { maxSteps: 2 }),
    /Agent reached the 2-step limit/,
  );
  assert.equal(calls, 2);
});

test("maxSteps must be a positive safe integer", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return searchToolsTurn();
  };

  await assert.rejects(
    agent("test", {}, undefined, undefined, {}, undefined, undefined, undefined, { maxSteps: 0 }),
    /maxSteps must be a positive safe integer/,
  );
  assert.equal(calls, 0);
});
