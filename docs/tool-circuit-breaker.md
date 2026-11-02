# Tool circuit breaker

`withToolCircuitBreaker` is an opt-in wrapper for tools backed by an unreliable service. It opens after a configurable number of consecutive failures, rejects calls without invoking the tool while open, then allows exactly one half-open probe after a cooldown. A successful call resets the circuit. A failed probe starts a new cooldown.

```ts
import { withToolCircuitBreaker } from "../src/tool-circuit-breaker.ts";

const lookup = withToolCircuitBreaker({
  description: "Look up a record",
  parameters: { type: "object", properties: { id: { type: "string" } } },
  run: async ({ id }, context) => {
    const response = await fetch(`https://example.com/records/${id}`, {
      signal: context?.signal,
    });
    if (!response.ok) throw new Error(`Lookup failed: ${response.status}`);
    return response.json();
  },
}, {
  failureThreshold: 4,
  resetTimeoutMs: 15_000,
  shouldCountFailure: error => !(error instanceof TypeError),
});
```

`failureThreshold` defaults to 5 and `resetTimeoutMs` to 30 seconds; both must be positive safe integers. `shouldCountFailure(error)` defaults to `true` and can exclude errors that do not indicate a dependency failure. Cancellation from the caller's `AbortSignal` is never counted. An open circuit rejects with `ToolCircuitOpenError`, whose `retryAt` property is the earliest timestamp (milliseconds since epoch) for another attempt. Circuit state belongs to one wrapper instance in one process; it is not shared across workers or machines.
