# Tool fallback

`withToolFallback` is an opt-in wrapper for a primary tool with a compatible backup implementation. It returns the primary result when that call succeeds. If the primary throws, the wrapper invokes the fallback with the same parsed input and `ToolContext`, then returns its result. If the fallback also throws, its error is propagated unchanged.

```ts
import { withToolFallback } from "./src/tool-fallback.ts";

const lookup = withToolFallback(
  {
    description: "Look up a record",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    run: async ({ id }, context) => {
      const response = await fetch(`https://primary.example/records/${id}`, {
        signal: context?.signal,
      });
      if (!response.ok) throw new Error(`Primary lookup failed: ${response.status}`);
      return response.json();
    },
  },
  {
    description: "Look up a record from the backup service",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    run: async ({ id }, context) => {
      const response = await fetch(`https://backup.example/records/${id}`, {
        signal: context?.signal,
      });
      if (!response.ok) throw new Error(`Backup lookup failed: ${response.status}`);
      return response.json();
    },
  },
  { shouldFallback: error => !(error instanceof TypeError) },
);
```

By default, any thrown primary error triggers fallback. Supply `shouldFallback(error)` to restrict that behavior; for example, avoid a backup request for invalid input or other permanent errors. A predicate that returns false rethrows the original primary error. Predicate exceptions propagate as-is.

The wrapper does not retry a successful but undesirable result. The primary and fallback should accept compatible input and return compatible outputs; the model sees the primary tool's description and parameter schema. If the agent's `AbortSignal` is aborted while the primary is failing, the abort reason is propagated and the fallback is not started. Both implementations receive the same `ToolContext` and should observe its signal during asynchronous work. This wrapper cannot forcibly stop arbitrary JavaScript.
