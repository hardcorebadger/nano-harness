# nano-harness

A tiny TypeScript agent harness: one tool-calling loop, no runtime dependencies, and any OpenAI-compatible chat API.

```sh
npm install
export OPENAI_API_KEY=...
npx tsx -e 'import { agent } from "./src/index.ts"; console.log(await agent("What is 2 + 2?", {}))'
```

Add tools as `{ name: { description, parameters, run } }`. `parameters` is a JSON Schema object; `run` receives parsed arguments and may be async. Set `MODEL` or `BASE_URL` to use another OpenAI-compatible endpoint. The loop stops after eight model turns.

Tools are deferred by default: mark a tool `always: true` to include it in every native model call. `search_tools` uses OpenAI-compatible embeddings (`text-embedding-3-small` by default) to vector-search deferred tool names, descriptions, and schemas; its top five results are added to the active tool set and appear in the native model call on the next loop turn. The active set has a soft cap of 25 tools and a hard cap of 100, including always-available tools and `search_tools`. At the soft cap, it evicts the least-recently-found unused deferred tool first. If all deferred tools have been used, it grows toward the hard cap; at the hard cap, it evicts the least-recently-used deferred tool. Set `EMBEDDING_MODEL` to override the embedding model; embeddings use `BASE_URL` and `OPENAI_API_KEY` too.

This is a deliberately small starting point, not a production framework: tool validation, retries, persistence, and streaming are left to the caller.
