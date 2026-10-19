# Task-time trust fixture

`startTaskTrustServer()` from `task-trust-server.mjs` exposes a localhost HTTP endpoint and a ready-to-use `definition` for `createCompleteMcpClient` configuration. Always close the returned fixture. Its authentication value is synthetic test data, not a real credential.

The official SDK client and ext-tasks driver are exercised by the actual Pi host tests. The official SDK Server and HTTP transport own legacy core/peer traffic. Tool-task creation results and modern extension frames are controlled because the base SDK Server validates fixed tool results and does not supply a tool-task receiver. No production modules are mocked.

## Real-model verification integration

```ts
const fixture = await startTaskTrustServer({ era: "modern", peerTimeoutMs: 30000, samplingMaxTokens: 2048 });
// Merge into the verification client's config:
// mcpServers.taskTrust = fixture.definition
// settings.sampling = true
// settings.samplingAutoApprove = false
// settings.elicitation = true
// Use actual Pi UI callbacks that record explicit approvals.
// Ask the real agent to call taskTrust's sampling tool once.
// Its task input asks the sampling model for TASK_SAMPLING_APPROVED_RESULT.
const evidence = fixture.report();
await fixture.close();
```

`report()` returns JSON-safe evidence:

```ts
{
  schemaVersion: 1,
  protocolEra: "modern" | "legacy",
  taskCount: number,
  tasks: Array<{
    taskId: string;
    kind: "sampling" | "elicitation";
    polls: number;
    resultRequests: number;
    terminal: boolean;
    inputAction?: "accept" | "decline" | "cancel";
    samplingReturned: boolean;
  }>,
  clientMethods: string[],
  violations: string[]
}
```

Record model/provider identity, explicit request/response approvals, wall time, usage and source hashes in the verification runner's existing report. A marker alone is insufficient: inspect `fixture.inputs` and the task's terminal tool result to verify it came through a task `inputRequests`/`tasks/update` exchange rather than an ordinary nested sampling call. Report fields omit model content; raw fixture wire/input arrays are available to assertions.

`peerTimeoutMs` controls only this fixture's legacy server peer sampling/elicitation requests. Its default is 2000 ms for unit checks; real-model runners can pass 30000 ms. It does not change SDK timeouts globally.

`samplingMaxTokens` controls the fixture's sampling request in either era (default 100). The live runner uses 2048 because Gemini's reasoning consumes the output budget: the preserved 100-token trial returned only `TASK`, not the full required marker. The exact-marker assertion remains unchanged.

## Current evidence boundaries

- Actual Pi holds the sampling request approval open and proves the provider has not run. Response approval is separately held open and proves no task update was sent yet.
- Declined elicitation produces an explicit `action: decline` on `tasks/update`.
- Declined sampling stops local work and withholds model output. Current SDK/adapter behavior sends neither an accepted sampling response nor a synthetic decline/error result; this fixture does **not** claim a wire decline or remote terminal transition for sampling denial.
- Two legacy tasks can receive interleaved peer requests on task-get SSE streams with distinct accept/decline decisions and correctly matched JSON-RPC IDs. The response `related-task` assertion was RED (metadata absent), and now passes through the SDK handler-wrapper integration.
- With default `requireResult: true`, legacy input is held until preemptive `tasks/result`. This was RED (both tasks polled, no result request), and now passes through the public execution event hook and SDK request API. The official ext-tasks 0.2.2 v1 driver remains responsible for execution and terminal result retrieval.
- `requireResult: false` lets the server send peers on a task-get stream, allowing correlation evidence independently of that preemptive-result defect. Both transports are permitted by the pinned legacy specification.
- Missing related-task metadata is not blanket-denied. It may use standalone trust gates. Malformed/wrong-owned-task evidence cannot borrow another task's consent: tests deny independently surfaced requests or accept the SDK's fail-closed protocol handling, never require the client to infer server intent from absent metadata.

Normative sources: [legacy input-required SHOULD](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/38c84e9f93ad191d9eb26d92b945d17bd0efcaf3/docs/specification/2025-11-25/basic/utilities/tasks.mdx#input-required-status), [legacy related-task messages MUST](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/38c84e9f93ad191d9eb26d92b945d17bd0efcaf3/docs/specification/2025-11-25/basic/utilities/tasks.mdx#associating-task-related-messages), [modern task input trust](https://github.com/modelcontextprotocol/ext-tasks/blob/899c1bbc869567670093face3591b39c28ce3219/specification/2026-07-28/tasks.md#task-update-requests).
