import assert from "node:assert/strict";
import { test } from "node:test";
import { withToolTimeout } from "../src/tool-timeout.ts";

const tool = run => ({ description: "test tool", parameters: { type: "object" }, run });

test("withToolTimeout returns a completed tool result", async () => {
  const wrapped = withToolTimeout(tool(async () => "ok"), 100);
  assert.equal(await wrapped.run({}), "ok");
});

test("withToolTimeout aborts the tool and rejects when its deadline passes", async () => {
  let toolSignal;
  const wrapped = withToolTimeout(tool((_, context) => {
    toolSignal = context.signal;
    return new Promise(() => {});
  }), 5);

  await assert.rejects(wrapped.run({}), error => error.name === "TimeoutError");
  assert.equal(toolSignal.aborted, true);
  assert.equal(toolSignal.reason.name, "TimeoutError");
});

test("withToolTimeout propagates cancellation from its parent signal", async () => {
  const controller = new AbortController();
  let toolSignal;
  const wrapped = withToolTimeout(tool((_, context) => {
    toolSignal = context.signal;
    return new Promise(() => {});
  }), 1000);
  const run = wrapped.run({}, { signal: controller.signal });
  const reason = new Error("cancelled by caller");
  controller.abort(reason);

  await assert.rejects(run, error => error === reason);
  assert.equal(toolSignal.aborted, true);
});

test("withToolTimeout rejects invalid timeout values", () => {
  assert.throws(() => withToolTimeout(tool(() => null), 0), /timeoutMs must be a positive safe integer/);
  assert.throws(() => withToolTimeout(tool(() => null), 1.5), /timeoutMs must be a positive safe integer/);
});
