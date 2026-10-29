# nano-harness

A tiny TypeScript agent harness: one tool-calling loop, no runtime dependencies, and any OpenAI-compatible chat API.

```sh
npm install
export OPENAI_API_KEY=...
npx tsx -e 'import { agent } from "./src/index.ts"; console.log(await agent("What is 2 + 2?", {}))'
```

Add tools as `{ name: { description, parameters, run } }`. `parameters` is a JSON Schema object; `run` receives parsed arguments and may be async. Set `MODEL` or `BASE_URL` to use another OpenAI-compatible endpoint. The loop stops after eight model turns.

Tools are deferred by default: mark a tool `always: true` to include it in every native model call. `search_tools` uses OpenAI-compatible embeddings (`text-embedding-3-small` by default) to vector-search deferred tool names, descriptions, and schemas; its top five results are added to the active tool set and appear in the native model call on the next loop turn. The active set has a soft cap of 25 tools and a hard cap of 100, including always-available tools and `search_tools`. At the soft cap, it evicts the least-recently-found unused deferred tool first. If all deferred tools have been used, it grows toward the hard cap; at the hard cap, it evicts the least-recently-used deferred tool. Set `EMBEDDING_MODEL` to override the embedding model; embeddings use `BASE_URL` and `OPENAI_API_KEY` too.

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

Steering is opt-in via a `SteeringQueue`. Keep a queue for the active run and call `send` whenever the user sends a message. The run consumes queued messages in order after the current model response and all its tool calls complete, then continues with another model call. Messages arriving during a final text-only response also interrupt that return and are processed on the next turn. Pass the queue as the sixth `agent` argument:

```ts
import { agent, SteeringQueue } from "./src/index.ts";

const steering = new SteeringQueue();
const run = agent("Start a task", tools, undefined, undefined, {}, steering);
// In the host's message handler, while `run` is active:
steering.send("Actually, use the compact format.");
const answer = await run;
```

The host owns message delivery and should only call `send` for new user messages belonging to that run. Steering waits for all tool calls in the current assistant turn; it does not cancel an in-flight model request or tool.

This is a deliberately small starting point, not a production framework: tool validation, retries, persistence, and streaming are left to the caller.
