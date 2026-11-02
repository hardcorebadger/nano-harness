# Tool metrics

`withToolMetrics` is an opt-in wrapper for observing one tool instance without adding a metrics dependency or global state:

```ts
import { withToolMetrics } from "../src/tool-metrics.ts";

const lookup = withToolMetrics({
  description: "Look up a record",
  parameters: { type: "object", properties: {} },
  run: async (input, context) => {
    const response = await fetch("https://example.com/lookup", {
      signal: context?.signal,
    });
    return response.json();
  },
});

// Register lookup as a normal tool. Read metrics whenever useful:
console.log(lookup.getMetrics());
```

Each call to `getMetrics()` returns a new snapshot with `calls`, `succeeded`, `failed`, and `inFlight` counts, plus `totalDurationMs`, `averageDurationMs`, `lastDurationMs`, and `maxDurationMs`. Calls are counted when they start; a returned or thrown result updates the outcome counts and duration when the call settles. Rejected calls, including cancellations, count as failures. The wrapper preserves the tool's description, schema, flags, input, context, result, and thrown error.

Metrics are scoped to the wrapper instance and process. They are in-memory observations only: the helper does not persist, export, reset, or aggregate metrics across wrappers or processes.