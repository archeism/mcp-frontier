# Pi 1.3 MCP client integration

Target: **Pi 1.3.0**, official modular **MCP SDK 2.3.1**, protocol **2026-07-28**, with legacy negotiation. This local fork combines the adapter, Events and final SEP-2640 Skills in one Pi extension. See `THIRD_PARTY.md` for frozen upstream sources.

## Run

```sh
cd /path/to/pi-mcp-complete
bun install --frozen-lockfile
pi --no-mcp -e ./complete.ts
```

Use a Pi 1.3 executable. The machine's global `pi` was 1.2.0 when this integration was built; the tests deliberately use the local 1.3.0 package, not that global executable. To use the pinned local CLI:

```sh
node node_modules/@earendil-works/pi-coding-agent/dist/cli.js --no-mcp -e ./complete.ts
```

Only load this combined extension once; do not separately load the original adapter or Events companion. Disable Pi's built-in MCP extension to avoid duplicate server connections. Existing adapter configuration is supported. Project-local example `.pi/mcp-adapter.json`:

```json
{
  "mcpServers": {
    "example": {
      "url": "https://your-server.example/mcp",
      "protocolVersion": "auto"
    }
  }
}
```

`auto` enables modern discovery with legacy fallback. Pin `2026-07-28` when a server must support modern extensions. An omitted version retains the adapter's legacy behavior; it does **not** implicitly enable modern extensions.

## Model-facing surfaces

For one top-level model tool, use [native Pi codemode-only integration](docs/native-codemode.md). It keeps the MCP tools callable underneath stock Pi's codemode and leaves the separate `mcpScript` sandbox disabled.

| Tool | Purpose |
| --- | --- |
| `mcp` | Search/describe/call remote tools through the adapter's approval, OAuth, Tasks and output handling |
| `mcp_protocol` | Discovery/status, core requests, resource subscriptions, notification watches and task management |
| `mcp_events` | One API for event catalogs, poll/push/webhook subscriptions, durable session state and cancellation; accepted events wake an agent turn |
| `mcp_skills` | List/get metadata, explicitly load a skill, verified file reads and directory browsing |

Core calls use `{ "server": "example", "action": "resources/read", "params": { "uri": "..." } }`. Tool calls through `mcp_protocol` use `tools/call` with `params.name` and `params.arguments`; they reuse the adapter's approval/Tasks path, not a raw SDK escape hatch. Modern subscriptions return an ID; unsubscribe uses `params.id`.

Interactive sampling presents full text and tool arguments before provider execution and full generated content before returning it to the server. Native Pi's existing select/editor UI offers prompt-text and tool-argument editing, followed by approval of the edited content. Editing never changes the original server request or authorized session context. Cancellation fails closed. Server-supplied history is labeled untrusted, not proof that Pi executed its tools. Confirm-only embedded interfaces can review/deny but cannot edit; binary image pixels and private thinking are explicitly not displayed in the text review. Explicit sampling auto-approval remains an operator choice.

Skills use `{ "server": "example", "action": "load", "uri": "skill://example/demo/SKILL.md" }`. Static manifests bind approval to all resource URIs/digests; changed manifests revoke approval. Dynamic Skills require explicit `allowUnpinned: true`, and fresh consent on every supporting-file read. No remote hook, script or `allowed-tools` field grants permissions. Content remains origin-tagged untrusted data. Cross-origin reads and tool execution during a remote-skill window require per-call consent. No files are silently installed as trusted local Skills.

## Protocol coverage and evidence

| Surface | Implementation / evidence |
| --- | --- |
| Version negotiation, initialization, discovery, capabilities, identity/instructions, shutdown | Official SDK; manager handshake/discovery tests; core tests |
| stdio, Streamable HTTP, SSE compatibility, reconnect, cancellation/deadlines | Official SDK transports; transport/ownership/recovery tests; real stdio and HTTP fixtures; HTTPS ALPN prefers HTTP/2 with HTTP/1.1 fallback |
| Tools, schemas, annotations, structured content, text/image/audio/resource results | Adapter tool/output handling and its regression suite; core calls preserve original results |
| Resources: listing, templates, reads, pagination, subscriptions and list changes | Manager/resource tests; core protocol tests; modern acknowledgement/subset validation |
| Prompts: listing, arguments, retrieval and list changes | Prompt tests and real core fixture |
| Argument completion | Core `completion/complete`, real fixture |
| Roots | Ordinary and task-input roots share the actual workspace file URI |
| Sampling: model hints, system prompt, text/images, tools/tool choice/results, limits/options, consent, context, cancellation | Official SDK callbacks; sampling tests; legacy Tasks receiver |
| Elicitation: forms/defaults, URL interaction/completion, decline/cancel | Adapter elicitation tests; official conformance; modern input-required path |
| Progress and logging | Notification observation, legacy log-level requests, task progress and transport traces. Modern ping/log-level requests are rejected locally by SDK 2.3.1, verified absent from wire traffic |
| Modern multi-round input-required | Official SDK tool handling and official Tasks input routing |
| Tasks | Official ext-tasks SDK: initiation, polling, input, outcome, cancellation and standalone management |
| Events | Vendored native Events implementation; real transport and actual Pi idle wake-up test |
| Skills, final SEP-2640 | `mcp-skills.ts`; real stdio metadata, direct-URI loading, integrity, revocation, dynamic consent and traversal tests |
| MCP Apps | Retained adapter Apps bridge, consent and CSP; actual headless Chrome CSP test |
| OAuth | Official SDK discovery/DCR/CIMD/PKCE, refresh, scope challenges, client credentials, private-key JWT and cross-app exchange; official conformance and auth regressions |

This table identifies implementation paths, not a claim that every possible server/provider combination has been exercised. The final verification manifest records actual command results and exceptions.

Events is still an [experimental working-group proposal](https://github.com/modelcontextprotocol/experimental-ext-triggers-events), not a finalized addition to the base protocol. This implementation targets pinned draft `d5316be214be2e76e51462069c1d67e00a5a7619`. Poll, push and signed HTTPS webhook delivery are implemented. Automatic mode selection prefers a configured webhook receiver, then push, then poll; explicit modes do not downgrade on failure. Use `mcp_events` actions `catalog`, `subscribe`, `list`, `unsubscribe` and `rotate_secret`. The earlier separate `mcp_event_delivery` tool has been removed.

Webhook ingress is operator-owned: pass `events.webhook.receiver` and `events.webhook.callbackBaseUrl` to `createCompleteMcpClient`. The callback URL must use HTTPS. `WebhookReceiver` handles signed requests; `startWebhookListener` optionally binds HTTP behind a trusted TLS reverse proxy or native HTTPS with supplied certificate/key files. This extension does not deploy public infrastructure. Keys are generated locally and kept in private session storage, never returned to the model. Registration/renewal/rotation use the configured authenticated MCP connection.

Subscriptions, cursors and accepted deliveries survive process restart in the same persistent Pi session/configuration. Events are acknowledged only after final successful, non-aborted settlement records a version-2 consumption receipt. Persistent sessions require a complete receipt row on disk; a memory entry left behind by a failed Pi write is not proof. Earlier unversioned receipts cannot prove final settlement, so still-pending events may replay after upgrade. Explicit in-memory Pi sessions offer volatile consumption only. Interrupted turns can replay; exactly-once agent side effects and macOS hardware power-loss durability are not claimed. Tasks likewise retain SDK task references and input decisions, resume known work after session recovery, and refuse to blindly repeat unknown creation outcomes. Registry checks on 2026-10-16 found no published official `@modelcontextprotocol/ext-events` or `ext-skills` package; extension calls use the official client's existing transport, framing and request machinery. The requirement audits and `PROTOCOL-COMPLETION.md` track remaining acceptance work; this paragraph is not a completion certificate.

Operator integrations can observe `MCP_EVENTS_STATUS_EVENT` on Pi's event bus. Its frozen, versioned status payload reports subscription state without delivery bodies or secrets and does not force a model turn. Tasks status notifications are also exposed through the protocol notification surface, using official SDK capability/filter helpers and schemas; polling remains supported independently.

An operator may supply `events.presentEvent(delivery, context, signal)` to redact or sandbox event data before Pi/model presentation. The context identifies the actual session, configured server, subscription and event. The callback receives a copy; the durable raw record and receipt identity remain unchanged. Throwing rejects presentation without acknowledgement; session replacement aborts pending policy work. Returned data remains untrusted and cannot grant tool permissions. This is a policy integration boundary, not a claim that arbitrary prompt injection can be automatically removed.

New sessions share private host-level Events inbox and Tasks recovery stores, with session-scoped identities. Admission is bounded and fails closed at capacity; pending records and deduplication tombstones are not silently evicted. Events delivery batches are limited to 100 records and 1 MiB. Existing per-session stores remain selected; obsolete immutable-file inboxes require explicit migration and are preserved rather than ignored.

The Events registry durably pins its shared/session inbox selection under the existing exclusive lease before delivery starts. An empty directory cannot change that choice on restart. Conflicting populated locations—including retained acknowledged identities—fail closed for operator resolution; unrelated sessions' shared records do not block legitimate legacy storage. No records are automatically migrated or deleted. Task-store physical-exhaustion errors retain the original SQLite error and previous durable reference/accounting.

URL elicitation displays the full URL, destination host and configured server before explicit browser approval, with warnings for Punycode/internationalized hosts and misleading userinfo. It does not prefetch URLs or impose a blanket block on valid local/private endpoints.

## Explicit limits

- Pi 1.3 has no audio sampling message representation, assistant-image representation, or arbitrary binary-resource representation for model sampling. These requests return explicit errors. Remote audio/blob results are preserved as private temporary files; Pi's model receives their paths, not native audio. Ordinary adapted binary files retain 10 MiB/file and 100 MiB/session safety limits. Verified Skills resources support the stable spec's 16 MiB bound and origin-preserving paths; raw core resource reads preserve protocol data.
- Stop sequences depend on the chosen Pi provider. Anthropic, Google, Bedrock, OpenAI Completions and Mistral have mappings; Responses-family and Pi Messages APIs do not expose the needed field. Generic provider stop reasons cannot prove a specific stop sequence was hit.
- Model cost/speed/intelligence priorities are advisory; model hints/current availability drive selection. Unsupported choices are not silently converted.
- Ping and `logging/setLevel` are available on legacy connections. The installed official SDK rejects them for modern 2026-07-28 connections; this adapter does not bypass that version restriction.
- Headless remote-skill activation/context sharing is denied without interactive consent. Sampling auto-approval does not grant permission to share session context.
- One official legacy OAuth test expects accepting inconsistent issuer metadata. Strict issuer validation remains enabled; this known failure must stay visible rather than be described as full conformance.
- The official conformance package installed here primarily covers 2025 revisions and OAuth. Separate 2026 real-transport and Pi host tests provide modern-extension evidence; they are not an official certification.
- Deterministic Pi host tests use the official faux model. Separate live Gemini verification proves real model calls, nested sampling, idle event wake-ups and all three Events delivery modes; neither substitutes for the other's coverage.

## Reproduce

```sh
bun run typecheck
bun run build:public
bun run test:vitest --maxWorkers=2 --minWorkers=1
bun run test:oauth
bun run test:public-exports
bun run test:conformance
bun run test:live-gemini
bun run test:live-events-delivery
bun run test:live-events-modes
bun run test:live-task-trust
bun run verify:complete
```

Build the retained visualizer example before the full inherited suite (`cd examples/interactive-visualizer && bun install --frozen-lockfile && bun run build`). Conformance runs are sequential and retained under timestamped directories; reviewed failures are explicit in `conformance/baseline-client.yml`.

The installed extension entry is `complete.ts`; `index.ts` remains the original adapter factory for compatibility. Public helper exports remain available. `bun pm pack` produces the installable local package; publishing and global installation are not performed automatically.

`verify:complete` runs all gates, rejects skipped Vitest cases and source changes during verification, retains raw output outside this package, and writes `VERIFICATION.json`. It distinguishes the expected issuer-metadata failure from passing conformance scenarios. The packed-package check loads the package through Pi 1.3's real extension file loader and repeats the host workflow.

Development uses Personal's Addy API/interface-design and test-driven-development skills directly: stable public contracts, boundary validation, intent-preserving retries, and reproduced failures before fixes. Characterization tests that already passed are recorded as such, not described as RED→GREEN. Skills are unchanged; implementation evidence is not a claim of skill improvement.
