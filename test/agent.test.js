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

const toolTurn = (name, args = "{}") => new Response(JSON.stringify({
  choices: [{
    message: {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call-1",
        type: "function",
        function: { name, arguments: args },
      }],
    },
  }],
}), { headers: { "content-type": "application/json" } });

const finalTurn = (content) => new Response(JSON.stringify({
  choices: [{ message: { role: "assistant", content } }],
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

test("tool failures are returned to the model so it can recover", async () => {
  let calls = 0;
  let toolMessage;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const request = JSON.parse(init.body);
    if (calls === 1) return toolTurn("flaky_tool");
    toolMessage = request.messages.find(message => message.role === "tool");
    return finalTurn("I recovered after the tool failed.");
  };

  const answer = await agent(
    "Try the flaky tool",
    {
      flaky_tool: {
        description: "A tool that can fail",
        parameters: { type: "object" },
        always: true,
        run: async () => { throw new Error("temporary outage"); },
      },
    },
  );

  assert.equal(answer, "I recovered after the tool failed.");
  assert.equal(calls, 2);
  assert.deepEqual(JSON.parse(toolMessage.content), { error: "temporary outage" });
});

test("tool failure handling does not swallow cancellation", async () => {
  globalThis.fetch = async () => toolTurn("cancel_tool");
  const controller = new AbortController();
  const reason = new Error("cancelled by caller");

  await assert.rejects(
    agent(
      "Cancel during tool execution",
      {
        cancel_tool: {
          description: "A test tool",
          parameters: { type: "object" },
          always: true,
          run: async () => {
            controller.abort(reason);
            throw reason;
          },
        },
      },
      undefined,
      undefined,
      {},
      undefined,
      undefined,
      controller.signal,
    ),
    error => error === reason,
  );
});
