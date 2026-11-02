# nano-harness

A tiny TypeScript agent harness: one tool-calling loop, no runtime dependencies, and any OpenAI-compatible chat API.

```sh
npm install
export OPENAI_API_KEY=...
npx tsx -e 'import { agent } from "./src/index.ts"; console.log(await agent("What is 2 + 2?", {}))'
```

Add tools as `{ name: { description, parameters, run } }`. `parameters` is a JSON Schema object; `run` receives parsed arguments and may be async. Set `MODEL` or `BASE_URL` to use another OpenAI-compatible endpoint. The loop stops after eight model turns by default.

Tools are deferred by default: mark a tool `always: true` to include it in every native model call. `search_tools` uses OpenAI-compatible embeddings (`text-embedding-3-small` by default) to vector-search deferred tool names, descriptions, and schemas; the top five matches are added to the active set and appear in the next model call. The active set has a soft cap of 25 tools and a hard cap of 100, including always-available tools and `search_tools`. At the soft cap, it evicts the least-recently-found unused deferred tool first. If all deferred tools have been used, it grows toward the hard cap; at the hard cap, it evicts the least-recently-used deferred tool. Set `EMBEDDING_MODEL` to override the embedding model; embeddings use `BASE_URL` and `OPENAI_API_KEY` too.

Basic skill support is opt-in via the fifth `agent` argument. Each skill has a short `description` shown in the system prompt and a lazy `load` callback. The built-in, always-available `read_skill` tool invokes the callback only when requested and returns the full instructions to the model:

```ts
import { readFile } from "node:fs/promises";
import { agent } from "./src/index.ts";

const skills = {
  "csv-export": {
    description: "Use when the user asks to export tabular data as CSV.",
    load: () => readFile("./skills/csv-export/SKILL.md", "utf8"),
  },
};

const answer = await agent("Export these records as CSV", tools, undefined, undefined, skills);
```

The harness does not discover files or grant filesystem access itself: the host chooses which skills to expose and implements each loader. Only expose trusted skill files, and have loaders constrain paths rather than accepting model-provided paths.

Steering is opt-in with a `SteeringQueue`. Keep a queue for the active run and call `send` whenever the user sends a message. The run consumes queued messages in order after the current model response and all its tool calls finish, then continues with another model call. Messages arriving during a final text-only response also interrupt that return and are processed on the next turn. Pass the queue as the sixth `agent` argument:

```ts
import { agent, SteeringQueue } from "./src/index.ts";

const steering = new SteeringQueue();
const run = agent("Start a task", tools, undefined, undefined, {}, steering);
// In the host's message handler, while `run` is active:
steering.send("Actually, use the compact format.");
const answer = await run;
```

The host owns message delivery and should only call `send` for new user messages belonging to that run. Steering waits for all tool calls in the current assistant turn; it does not cancel an in-flight model request or tool.

Streaming is opt-in with the seventh `agent` argument, a callback invoked as text arrives. Tool-call arguments are accumulated internally and tools run only after the streamed model turn is complete. The promise still resolves to the full final answer, so existing callers remain compatible:

```ts
const answer = await agent(
  "Explain what this harness does",
  tools,
  undefined,
  undefined,
  {},
  undefined,
  chunk => process.stdout.write(chunk),
);
```

When a callback is provided, chat completions request OpenAI-compatible server-sent events (`stream: true`). Without one, the harness uses the existing non-streaming response path.

Cancellation is opt-in with the eighth `agent` argument. Its signal is passed to chat and embedding requests and is available to tools as their optional second `run` argument. Existing one-argument tools continue to work:

```ts
const controller = new AbortController();
const run = agent("Do a cancellable task", tools, undefined, undefined, {}, undefined, undefined, controller.signal);
// Later, for example when the user stops the run:
controller.abort();
await run; // rejects with the abort reason (or an AbortError)
```

Tools can use `context?.signal` to cancel their own asynchronous work. Cancellation stops the agent instead of returning a partial answer.

The optional `withToolTimeout` helper applies an independent deadline to an individual tool. It forwards the agent's abort signal, gives the tool a signal that also aborts on timeout, and rejects with a `TimeoutError` if the deadline expires (even if the tool ignores cancellation):

```ts
import { withToolTimeout } from "./src/tool-timeout.ts";

const tools = {
  lookup: withToolTimeout({
    description: "Look up a record",
    parameters: { type: "object", properties: {} },
    run: async (_input, context) => {
      const response = await fetch("https://example.com/lookup", { signal: context?.signal });
      return response.json();
    },
  }, 5_000),
};
```

`timeoutMs` must be a positive safe integer. The wrapper cannot forcibly stop arbitrary JavaScript; tools should observe the provided signal to cancel their underlying work promptly.

The optional `withToolRetry` helper adds bounded exponential backoff for tools that can safely be called more than once. Retries are opt-in and apply to thrown errors; by default it makes at most three total attempts, starting with a 100ms delay and capping backoff at five seconds. Provide `shouldRetry(error, failedAttempt)` to avoid retrying permanent failures. **Only wrap idempotent tools** (or operations protected by an idempotency key): a timeout or network error can occur after a remote side effect already happened.

```ts
import { withToolRetry } from "./src/tool-retry.ts";

const tools = {
  lookup: withToolRetry({
    description: "Look up a record",
    parameters: { type: "object", properties: {} },
    run: async () => (await fetch("https://example.com/lookup")).json(),
  }, {
    maxAttempts: 4,
    initialDelayMs: 200,
    maxDelayMs: 3_000,
    shouldRetry: error => !(error instanceof RangeError),
  }),
};
```

The parent agent's `AbortSignal` is passed to every attempt and interrupts both in-flight waits and backoff delays. Configure `maxAttempts` as a positive safe integer, `initialDelayMs` as a non-negative safe integer, `maxDelayMs` as a safe integer at least as large as the initial delay, and `backoffFactor` as a finite number at least 1.

The optional `withToolRateLimit` helper spaces tool starts by a minimum interval, including concurrent calls made through the same wrapped tool. Tool work can overlap; only start times are spaced. Calls waiting for their turn honor the agent's `AbortSignal`, so cancelled queued calls never invoke the tool. The default interval is 1,000ms; set `minIntervalMs` to a non-negative safe integer no greater than 2,147,483,647:

```ts
import { withToolRateLimit } from "./src/tool-rate-limit.ts";

const tools = {
  lookup: withToolRateLimit({
    description: "Look up a record",
    parameters: { type: "object", properties: {} },
    run: async (input, context) => {
      const response = await fetch("https://example.com/lookup", { signal: context?.signal });
      return response.json();
    },
  }, { minIntervalMs: 250 }),
};
```

Rate limiting is per wrapper instance and process; it does not coordinate separate wrapped instances or multiple processes.

The optional `withToolConcurrencyLimit` helper caps the number of in-flight calls through one wrapped tool instance. Calls beyond the limit wait FIFO for a slot; queued calls respect the agent's `AbortSignal` and won't run if cancelled. The `maxConcurrent` argument must be a positive safe integer:

```ts
import { withToolConcurrencyLimit } from "./src/tool-concurrency-limit.ts";

const tools = {
  lookup: withToolConcurrencyLimit({
    description: "Look up a record",
    parameters: { type: "object", properties: {} },
    run: async (input, context) => {
      const response = await fetch("https://example.com/lookup", { signal: context?.signal });
      return response.json();
    },
  }, 3),
};
```

The concurrency limit is per wrapper instance and process; it does not coordinate separate wrapped instances or multiple processes. Calls already running are not forcibly stopped and should observe the supplied signal when they need to cancel their own work.

The maximum model-turn count is configurable with an optional ninth `agent` argument. It defaults to 8; invalid, zero, negative, or non-integer values are rejected before any request is sent:

```ts
const answer = await agent(
  "Work through this longer task",
  tools,
  undefined,
  undefined,
  {},
  undefined,
  undefined,
  undefined,
  { maxSteps: 16 },
);
```

The optional `withToolValidation` helper validates parsed tool arguments against the tool's declared `parameters` schema before invoking `run`, preventing invalid inputs from reaching tool side effects. It is dependency-free and supports the common keywords `type`, `enum`, `required`, `properties`, `additionalProperties: false`, string `minLength`/`maxLength`/`pattern`, numeric `minimum`/`maximum`/`exclusiveMinimum`/`exclusiveMaximum`, and array `items`/`minItems`/`maxItems`:

```ts
import { withToolValidation } from "./src/tool-validation.ts";

const tools = {
  search: withToolValidation({
    description: "Search records",
    parameters: {
      type: "object",
      properties: { query: { type: "string", minLength: 1 } },
      required: ["query"],
      additionalProperties: false,
    },
    run: async ({ query }) => searchRecords(query),
  }),
};
```

On invalid input the wrapper throws `ToolArgumentValidationError` before calling the tool. Like the retry and timeout helpers, this is opt-in; wrap only tools whose declared parameter schema accurately describes what their implementation accepts.

This is a deliberately small starting point, not a production framework: tool validation and persistence are left to the caller.
