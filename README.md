# nano-harness

A tiny TypeScript agent harness: one tool-calling loop, no runtime dependencies, and any OpenAI-compatible chat API.

```sh
npm install
export OPENAI_API_KEY=...
npx tsx -e 'import { agent } from "./src/index.ts"; console.log(await agent("What is 2 + 2?", {}))'
```

Add tools as `{ name: { description, parameters, run } }`. `parameters` is a JSON Schema object; `run` receives parsed arguments and may be async. Set `MODEL` or `BASE_URL` to use another OpenAI-compatible endpoint. The loop stops after eight model turns.

Tools are deferred by default: only `search_tools` is sent initially. The model searches the local tool catalog by name/description; the best five matches are loaded for its next turn. This is a tiny local keyword matcher, not provider-side tool search, and intentionally needs no extra API or dependency.

This is a deliberately small starting point, not a production framework: tool validation, retries, persistence, and streaming are left to the caller.
