# MCP Frontier on Pi Durable — prototype

Question: can Frontier's protocol engine serve a real Pi Durable agent, including Events that wake it, without embedding Pi CLI or building another code-mode runtime? **Yes**, for the surfaces demonstrated below.

This is an opt-in Node-host prototype on branch `prototype/pi-durable`, not the normal Pi extension entry point and not a complete Durable port. Pi Durable and code mode are pinned to 1.3.0. No existing production protocol module was changed.

## Run

```sh
git clone --branch prototype/pi-durable https://github.com/archeism/mcp-frontier.git
cd mcp-frontier
bun install --frozen-lockfile
bun run test:durable
bun run typecheck:durable
GEMINI_API_KEY_FILE=/path/to/your/managed-key-file bun run prototype:durable
```

The live runner defaults to the operator's existing managed Gemini key file on the development host. It reads the key into an in-memory credential store; no key is written to source, evidence, the Durable database, or command arguments. It uses real `google/gemini-3.8-flash` calls and incurs provider charges. Each run gets isolated temporary SQLite/Frontier state, retained for inspection. Evidence is written to the sibling `verification-evidence/` directory. No global Pi settings change.

## Native boundary

```text
Pi Durable generation → native codemode → native nested tool task
  → frontier_tools → Frontier connection manager + official MCP SDK/Tasks

MCP Event → Frontier coordinator → persistent inbox
  → Durable submit(stable requestId) → agent run → done → inbox ACK
```

`createDurableFrontier({ directory, servers, onError })` returns a native Durable `extension`, `attach(conversation)`, `flush()` and `close()`. Install the extension on the registry before opening the harness, obtain the conversation, then attach it before submitting work or resuming pending tools. Reinstall and reattach on every restart. Use one private directory per conversation/database and one live owner. Changing the database while reusing that directory is unsupported.

The host owns model credentials, storage, registry, approvals and shutdown. `servers` must be an explicit, trusted operator allowlist: definitions can start local processes and access credentials. The prototype does **not** reproduce Pi CLI's project-trust or interactive per-tool approval UI. Do not feed it untrusted project config. Install native Durable code mode separately and select only its actual tool registration in `modelTools`; leave the underlying Frontier tools callable.

Tools:

- `frontier_tools`: list/call tools, validate arguments, return the complete JSON MCP result envelope as `structuredOutput`. Scripts must inspect `isError`; schema-backed error envelopes do not necessarily throw.
- `frontier_events`: subscribe/list/cancel using poll or push. Accepted events are untrusted input, never permission grants. Their stable submission IDs deduplicate admission across the two stores; ACK follows successful completion. This does not make arbitrary agent side effects exactly-once.

Tool executions use Durable's `replay: "unsafe"`: an interrupted remote effect is not automatically repeated. Known completed nested calls remain in Durable's code-mode journal. This prototype does not yet bind Frontier's task recovery store to Durable invocation identity.

Close the harness and adapter when stopping the service. Adapter close cancels its own delivery waits, not an already admitted Durable run; it leaves that run for the harness to finish, abort or resume. Keep both the Durable SQLite database and Frontier state for recovery.

## Proof and limits

The live runner requires provider declarations to be exactly `["codemode"]`. A fixture generates a secret nonce/value unknown to the prompt; actual code-mode output must contain it after one immediate MCP call and one task-backed call. The wire must contain `tasks/get`. A subsequent event supplies new unpredictable operands/nonce; it wakes the actual agent, which computes through code mode. The fixture repeats that same event every poll.

After graceful SQLite close/reopen, the initial request ID must return the same submission, and a 2.3-second repeated-delivery observation must produce no new transcript entries, remote tool effects or provider requests. This is **not** SIGKILL recovery, interrupted MCP-task resumption, unattended processing guarantees or a load benchmark.

Not yet bridged: Skills discovery/activation/consent, Apps/UI routing, sampling, elicitation, OAuth interaction, resource/prompt tools, webhook exposure, every CLI hook, and cross-process deployment. The reused engines have additional features, but their existence is not proof that this host adapter supports them. Push is exposed through the existing coordinator; this prototype's live proof exercises poll only.

Independent read-only review checked the native boundary, cancellation and done-before-ACK ordering. Exact run evidence and verification results are recorded alongside this prototype. Operating skills were used unchanged; no skill-improvement claim is made.

The three deterministic tests use the real Durable harness, native code mode and HTTP MCP boundary with a controlled faux provider. They check unknown-server and foreign-conversation denial before HTTP, immediate/task/error envelope preservation, and an injected ACK failure **after** the event submission completed. SQLite reopen must find that same completed submission, clear the pending inbox entry and make no additional provider call. That failure-injection proof is separate from the real Gemini happy-path run.
