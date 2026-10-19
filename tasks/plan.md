# MCP Frontier × Pi Durable: full end-to-end verification plan

Status: **draft for Charles's review; implementation and acceptance runs have not started**.
Prepared 2026-10-20. Source baseline: `03ec00c1a10e4845516c886213098a4ae1bb0059`.
Task list: [todo.md](todo.md). Existing prototype: [README](../prototypes/pi-durable/README.md).

## 1. Outcome and recommendation

Success means a consumer can install MCP Frontier into **stock Pi Durable 1.3.0**, run a real Gemini-backed agent, use the required MCP capabilities through normal calls and native code mode, detach its client, and recover after process failure without losing accepted work, crossing conversation permissions, or silently repeating an uncertain remote effect.

Keep one MCP protocol implementation. Start with a **native Pi Durable adapter over Frontier's existing engines**, preferably a public `mcp-frontier/durable` entry point. This is a proposed export, not an existing one. Reuse the official MCP SDK, the existing Events coordinator, Skills integrity/consent policy, Tasks recovery, auth, and Apps bridge where their contracts permit. Do not emulate Pi CLI's `ExtensionAPI`, rebuild Pi, or create another code-mode runtime.

A durable-specific adapter is expected; a separate protocol fork is not the default. Permit a separate package/variant only after a failing public test proves the shared implementation cannot satisfy the host contract. Record the precise limitation, smallest change, dependents, and compatibility impact before taking that route. If Pi Durable needs a change, preserve a stock-1.3 failure reproducer and identify the required upstream fix; do not silently patch `node_modules` and advertise stock compatibility.

### What “fully” means

- Every required feature has a source requirement, an exposed host path, a passing externally observed test, a recovery/security verdict, and retained evidence.
- Required scope includes the core protocol and Frontier's retained advertised surfaces: Tasks, Events, Skills, Apps, auth, sampling, elicitation, resources, prompts, subscriptions, and native code mode. Versions and optional capabilities are explicit.
- An implementation existing in normal Pi does **not** establish its availability in Pi Durable. A successful SDK call does **not** establish agent integration. A graceful reopen does **not** establish crash recovery.
- Unsupported requests must fail or negotiate out correctly. A required supported flow that still cannot run is a gap, not a passing “N/A.” Any reduction of the requested scope needs Charles's approval.
- “Full client integration” does not mean every third-party server is durable, every provider supports every modality, or arbitrary external effects are exactly-once. Unknown remote outcomes must be visible and safely recoverable or explicitly require reconciliation.
- Freeze the target protocol/extension revisions. Inventory newer changes and experimental proposals separately; no unbounded promise to implement every future/private MCP extension. Filesystem, variants and interceptors must be classified against actual published contracts and Frontier exposure rather than silently treated as implemented.

### Scope boundaries

This plan covers the integration and its service-facing contract, including a real browser host for Apps and remote human decisions. It does not authorize building three production native clients, public infrastructure deployment, an npm release, a new server registry, or rewriting unrelated Pi Durable features. iOS/Android/desktop clients should consume one tested host contract; the representative acceptance client is a browser plus an automated reconnecting client. Additional runtime/storage/platform claims require their own evidence.

## 2. What exists, and what the evidence actually proves

| Item | Observed baseline | Meaning for this plan |
|---|---|---|
| Pi and Pi Durable | Local dependencies pin `1.3.0`; SDK client/core `2.3.1`; Tasks SDK `0.2.2` | Use installed artifacts and lockfile integrity, not a global `pi` executable or a moving tag |
| Core protocol | Frontier targets `2026-07-28` with legacy negotiation | Modern stateless metadata/discovery and legacy initialization are distinct contracts |
| Prototype adapter | `prototypes/pi-durable/frontier.ts` exports `createDurableFrontier`; two native tools | Not a complete replacement for the normal Pi extension |
| Native tool calls | `frontier_tools` lists/calls an operator-approved server and preserves the MCP JSON envelope | Real native code-mode integration exists; full proxy/direct/core/Apps policy parity is unproved |
| MCP Tasks | Immediate and task-backed calls work in the recorded run | Adapter does not call `manager.setTaskRecovery`; no Durable invocation binding or crash-resume proof |
| Events | Poll/push exposed; poll recorded with an idle Gemini wake | Webhook and full control surface are not exposed by this adapter; push has no recorded live Durable proof |
| Event settlement | Stable request ID, submission `done`, then inbox ACK | Good admission/ACK design; does not prove absence of duplicate external actions in an interrupted run |
| Restart | Graceful close/reopen in one runner | Not SIGKILL, a new OS process, server restart, machine migration, or power-loss proof |
| Human/model/UI paths | Prototype explicitly omits sampling, elicitation, Skills, Apps, interactive OAuth, resources/prompts | Reused engine capabilities must be bridged and verified through this host |
| Packaging | `private: true`; GitHub distribution exists; no durable public export; prototype not in package file allowlist | Keep GitHub-first distribution. Verify packed/remote consumer import; do not remove the npm safety lock just to test |
| Prior normal-Pi acceptance | `VERIFICATION.json` records 2,898 tests, 179 OAuth tests and real Gemini workflows | Historical regression floor, not a fresh result on this branch or a Durable certificate |

The recorded prototype used four Gemini provider requests, only `codemode` offered to the model, an unpredictable server value, a task poll, an event-derived calculation, and a 2.3-second duplicate observation after reopen. Its recorded elapsed time was 18.503 seconds. On this planning pass, the SHA-256 hashes of `frontier.ts`, `fixture.ts` and `live.ts` match that evidence file. **The run was not rerun during planning.**

Source anchors at the frozen baseline:

- [Prototype contract and limitations](../prototypes/pi-durable/README.md), especially lines 30–49.
- [Prototype implementation](../prototypes/pi-durable/frontier.ts): factory at 26; event admission/ACK at 53–67; native tools at 72–109; lifecycle at 114–132.
- [Live runner](../prototypes/pi-durable/live.ts) and [recorded evidence](../prototypes/pi-durable/evidence.json).
- [Normal Pi composition](../complete.ts): Tasks store, composed resource policy, Skills/core/Events installation.
- [Connection manager](../server-manager.ts): recovery binding at 464, sampling at 479, resource policy at 477, elicitation at 510.
- [Coverage/limits](../COMPLETE.md), [Tasks/Skills audit](../PROTOCOL-AUDIT-TASKS-SKILLS.md), [Events audit](../PROTOCOL-AUDIT-EVENTS.md), [release provenance](../docs/github-release.md).

These links are navigation aids, not acceptance assertions. V01 re-anchors them to the execution revision.

### Source-audit findings that change the plan

Two independent read-only agents audited the installed Durable implementation and Frontier's capability/evidence paths. The main agent checked the critical source locations. These are planning findings, not new runtime results:

- **Recovered safe tools bypass `beforeTool` hooks.** Installed Durable `dist/harness/tool.js` executes a recovered safe invocation directly. Authorization must therefore hold at the actual operation boundary, including recovery, not only in a pre-call hook. Revoked consent and changed server identity need crash tests.
- **Submission ID reuse does not compare payloads.** `dist/harness/submissions.js` deduplicates on conversation/request ID and checks submission type. The service/adapter must bind intent fingerprints or explicitly reject conflicting reuse; the lower-level dedup behavior alone is insufficient.
- **Interrupted generation can request the model again.** `dist/harness/generation.js` starts a fresh stream on recovery. Model requests and cost are not exactly-once. An unsafe call returning `interrupted` also does not prevent the model issuing a new call with a new invocation ID; uncertain-effect policy must cover that path.
- **Storage ownership is a host responsibility.** Durable's README says there is no cross-process locking. Its SQLite WAL/`synchronous=NORMAL` guarantee covers process failure, not loss of power. Establish ownership early in V25, before trusting recovery tests.
- **A watch is a snapshot/update interface, not an event archive.** Durable's observer coalesces slow-consumer queues above 100 frames. Clients must reconstruct current committed state on reconnect and must not depend on receiving every transient frame.
- **The existing headless-looking entry point is not a Durable adapter.** `host-managed.ts` still receives the CLI `ExtensionAPI` and covers a narrower tools/resources profile. Reuse contracts where suitable, not the assumption that it is drop-in Complete parity.
- **The inherited gate omits relevant tests.** `verify-complete.mjs` does not run `test:durable`. Root `mcp-auth-extensions.test.ts` is outside the Vitest include pattern and the explicit OAuth file list. V02 must compare required coverage with actually selected tests, not just aggregate passing counts.

## 3. Skill route and approval gates

The two requested routers were read in full from their installed files, including the portions truncated in the chat attachments.

| Stage | Skill | How it changes the work |
|---|---|---|
| Route | `addy:using-agent-skills`, `mattpocock:ask-matt` | Plan before building; retain assumptions and explicit phase transitions |
| Specify | `addy:spec-driven-development` | This draft contains a capability map and success contract; it is not an approved architecture |
| Plan | `addy:planning-and-task-breakdown` | One saved plan, one task list, vertical slices, acceptance evidence and blocking edges |
| Model interfaces | `addy:api-and-interface-design`, `mattpocock:codebase-design` | Stable intent identities, explicit unknown outcomes, few deep public test seams |
| Source grounding | `addy:source-driven-development` | Pin actual Pi/SDK artifacts and separate modern, legacy and experimental behavior |
| Implement later | `mattpocock:tdd` + Addy's incremental implementation | Confirm seams first; one RED → minimal GREEN slice at a time, not an imagined bulk test suite |
| Assess real runs | `csuite:evaluation-engineering` | Frozen apparatus, deterministic oracles, preserved failures, model/resource/cost evidence |
| Review/ship later | `mattpocock:code-review`, Addy's security, observability, browser and shipping skills | Load at the relevant phase; independent acceptance on the exact candidate, not self-report |
| Operate | `csuite:machine-local`, `csuite:rsi-loop`, `csuite:factory-mode`, orchestration | Preserve source/evidence; scale process to the task; no invented skill-improvement claim |

Matt's `to-spec`/`to-tickets` procedures inform the proposed spec-to-task flow, but **no tracker issues are published** and no `ready-for-agent` status is claimed before approval. Addy's `tasks/plan.md` and `tasks/todo.md` are the draft artifact convention. The project has no configured alternative tracker in its root agent instructions. Do not overwrite another unfinished plan.

The current goal is already clear enough to draft. No new product interview or architecture survey is needed. Remaining technical questions become early experiments. Human decisions are limited to approving this acceptance/seam contract, any genuinely unavoidable scope change, and later merge/release/deployment choices.

Search limitation: CodeGraph and `zg` were absent on PATH; the registrar had no usable local installation pointer beyond CodeGraph's general install note. Source inspection used known paths and exact searches, not claimed semantic/index coverage. Context7 was not exposed in this session. No source was uploaded for remote embeddings.

## 4. Proposed capability map and ownership

| Module ID | Responsibility | Depends on |
|---|---|---|
| `protocol-engine` | SDK transport, negotiation, tool/resource/prompt operations and existing protocol extensions | Official SDK and pinned specifications |
| `durable-host` | Native registry, conversation/tool identities, host policies and process lifecycle | `protocol-engine`, Pi Durable |
| `recovery` | Correlate remote Tasks, event admission, decisions and local durable outcomes | `durable-host` |
| `interaction` | Sampling, human decisions, remote Skills and Apps host routing | `durable-host`, `recovery` |
| `service-client` | Attach/reconnect clients and render committed state; no protocol reimplementation | `interaction` |
| `acceptance` | Installed-package, peer-wire, process-failure and real-model evidence | All above |

This is a responsibility map, not a mandate to create six new packages/classes. Reuse modules already in the repository. All actual schemas/export changes must include a dependent-call-site scan. Never preserve a duplicate code path merely because the prototype used it.

State ownership must be explicit:

- Pi Durable owns conversations, submissions, local task graph and native code-mode journal.
- Frontier owns its MCP session/recovery metadata, event cursors/inbox/deduplication and protocol policies, unless an experiment proves a smaller integration into Durable documents is necessary.
- MCP servers own remote execution, remote Task retention and source-event history. Client restart cannot recreate server data that no longer exists.
- The host owns authentication, authorization, secret resolution, interaction delivery and lifecycle scheduling. Remote MCP data cannot grant itself permission.
- The frontend renders and answers requests. Disconnecting a frontend must not implicitly cancel server work; explicit cancellation is a different action.

Keep one live writer per supported database/state directory unless the storage contract expressly supports otherwise. Test rejection of a second writer and recovery after an owner dies; do not invent distributed leases or a new queue platform without evidence they are needed.

Use the smallest deployment-level or library-level ownership mechanism that the supported host can enforce. Pi Durable does not supply this lock. V25 is an early prerequisite to recovery, even though its number groups it with operational coverage.

Preserve VISION's lazy startup: idle install/open must not connect every configured server. Only demanded calls, persisted recovery and active subscriptions justify their respective connections. Measure startup and model-visible declaration size against the frozen baseline; having one top-level tool does not by itself mean low context cost.

## 5. Five proposed public verification seams

These are proposed for approval before adding tests, as required by Matt's TDD skill. “Every seam” means all relevant observable behavior through these interfaces, not a test for every helper function.

| ID | Public seam | What the test drives | What proves behavior |
|---|---|---|---|
| S1 | Package/host lifecycle | Installed import → registry install → `Harness.open` → attach → close/reopen | Public exports, conversation identity, readiness/errors, released ports/processes and ownership |
| S2 | Agent execution | `conversation.submit`, native tool execution and native `codemode` → submission/entries/watch | Actual provider declarations, model tool request, preserved results, independent remote effects |
| S3 | MCP peer | Independent SDK servers and hostile wire peers over real transports | Version-specific RPC trace, capability framing, peer-visible result/side-effect ledger, absence of forbidden calls |
| S4 | Host/client interaction | Authenticated service client and browser Apps host; approvals, sampling policy and elicitation responses | User-visible pending/settled decisions, authorized effects, rendered UI and origin/CSP enforcement |
| S5 | Process recovery | External supervisor kills/restarts a worker using the same retained state | Reacquired public submission/task status, same logical effect, retained pending work, no lost accepted event |

Do not assert private class calls or query private SQLite tables as the acceptance oracle. Public transcript/task inspection and a **separate fixture-server effect ledger** are legitimate observations. Database inspection may diagnose a failure; it does not replace recovery through the public interface. Existing prototype ACK tests patch an internal method: retain them as supporting history, but add process/storage-failure evidence at a public adapter seam rather than calling that full crash proof.

### Two complementary test layers

1. **Deterministic contracts:** real Durable harness, real SDK/transport/storage, controlled faux provider only where needed to choose precise model actions. These exhaust error ordering, negative input and kill points cheaply.
2. **Real-model acceptance:** actual Pi Durable agent with the existing Gemini credential path, native code mode and independent MCP server. Observe the model request/response and resulting effects. No faux provider, monkeypatched agent loop or fake sampling response in this lane.

Every major host capability needs a real-model vertical scenario; every branch does not need a separate paid call. A nonce/value generated by the server after the prompt is fixed prevents a model from passing by echoing supplied expected text. Use semantic assertions and independent expected results, not an LLM judge as the sole oracle.

## 6. Exhaustive coverage ledger to build in V01

Each requirement row records: ID; protocol generation/revision; MUST/SHOULD/optional or host requirement; actual advertised capability; source anchor; host entry point; test ID; expected observation; fault/restart coverage; proof layer; latest evidence hash; verdict. Verdicts are `unverified`, `failed`, `passed`, `not-applicable-with-reason`, or `blocked-by-upstream`. A blocked required row blocks completion. A known limitation is never a hidden pass.

| Family | Required scenarios | Primary tasks |
|---|---|---|
| Installation | Native import from packed/Git source, no source rebuild or accidental CLI dependencies, no duplicated extension, clear missing dependency errors | V03, V28 |
| Negotiation | Modern discovery and per-request metadata; legacy initialization; explicit pin versus auto fallback; cache TTL/identity; extension opt-in and unsupported methods | V01, V03, V20 |
| Transports | stdio, Streamable HTTP, retained SSE compatibility, Unix sockets; supported TLS/proxy behavior; close, timeout, partial response, session expiry and reconnect | V20 |
| Tools | Discovery/pagination/change notices; schemas; result envelope/structured errors; content/annotations; no raw-call approval bypass; bounded output | V04, V05, V10 |
| Resources | List/templates/read/pagination; content/URI/schema validation; resource updates and subscriptions; reconnection; source identity and private materialization | V10 |
| Prompts/completion | List/get/arguments/change notices and completion; origin and content preservation; malformed/unsupported behavior | V11 |
| Roots/utilities | Real configured workspace roots, no host-cwd leak; version-appropriate ping/logging, progress, cancellation, notification correlation | V11, V20 |
| Task execution | Immediate versus task result, working/input-required/terminal states, poll hints, TTL, result/error validation, modern and legacy differences | V05, V12 |
| Task recovery/control | Persist remote handle before exposing progress; recover same invocation; task input decisions; notifications and polling; cancellation races, unknown creation outcome, stale endpoint/principal | V05, V12 |
| Events discovery/control | Catalog pages/changes, negotiation, explicit versus automatic mode, subscribe/list/unsubscribe, cursor/replay/truncation and schema changes | V06–V09 |
| Events poll | Idle wake, busy queue, `hasMore`, poll hints, cursor after acceptance, duplicate/conflicting delivery, offline catch-up | V06, V09 |
| Events push | Activation/heartbeats, disconnect/reconnect, cursor replay, sibling streams, no quiet-period false loss, cancellation | V07 |
| Events webhook | Real HTTPS ingress, authenticated subscription, signatures/raw bytes, duplicate/conflicting delivery, renewal/expiry/rotation, pending-secret races and unsubscribe | V08 |
| Sampling | Genuine nested Pi/Gemini execution, requested tools and limits, policy/context sharing, result review, cancellation, recursion and restart; unsupported modality is explicit | V13 |
| Elicitation | Form defaults/validation, accept/decline/cancel, URL interaction and completion, late answers, correlated Tasks input, client absent/reconnecting | V14 |
| Skills retrieval | Declaration/list/get/direct lookup, resource/directory reads, static manifests/digests/frontmatter, dynamic content, Unicode/traversal/authority, supported size/file bounds | V15 |
| Skills activation | Retrieval is not activation; fresh/revoked/nested consent, no name shadowing, immutable/origin-preserving cache, supporting reads and context across restart/compaction/fork | V16 |
| Apps content/UI | UI metadata/resource loading, initialization/messages, CSP/sandbox/origin, visibility, context updates, user actions, teardown and unsupported-host fallback | V17 |
| Apps effects | UI tools through the same authorization/Tasks recovery path, nested code-mode result-to-UI routing, stable action IDs, reload/reconnect without duplicate effects | V18 |
| Interactive auth | OAuth discovery/issuer/resource checks, DCR/CIMD/PKCE as supported, callback/state, refresh and scope changes, human interaction outside terminal, redaction | V19 |
| Noninteractive auth | Client credentials, private-key JWT and enterprise/cross-app modes actually exposed by pinned SDK; token refresh races, revocation and secret rotation | V21 |
| Host policy | Operator-approved config, project distrust by default, per-call permissions, context disclosure, remote data not instructions/authority, error/secret containment | V03, V14, V16, V19, V21, V26 |
| Native code mode | Exactly one model-visible tool when configured, hidden callable tools, nested hooks/replay/output/limits, deterministic replay, journal mismatch and interrupted nested effect | V04, V05, V18, V23 |
| Conversation lifecycle | submit idempotency, queue/steer/reject, wait cancellation versus work cancellation, reset/handoff/compaction, stop/resume, orphan/blocked definitions | V09, V22, V23 |
| Forks/children | Fresh ownership/provider identities, inherited permissions/context only as allowed, no event or Task theft, parent/child abort and cleanup | V22 |
| Registry/environment | Install/reload/uninstall, old running/new subsequent code, restart before scheduler starts, cwd/environment failure, hook ordering and scope | V03, V23 |
| Service/client | Submit/reacquire/watch/inspect/cancel and decision routes, current snapshot on reconnect, slow consumers, concurrent clients, auth/session isolation, no client-side secrets | V24 |
| Storage/operations | Exclusive ownership, atomic failure, full disk/quota/corruption fail-closed, matching backup/restore, format upgrades, retention and unknown outcomes | V25, V27 |
| Resource accounting | Model/tool usage without nested double counting, failed attempt cost, whole process-tree memory/CPU/I/O/disk, bounded queues and shutdown | V27 |
| Extension parity audit | Compare live upstream official/experimental list with explicit Frontier support; identify missing and server-only obligations; never infer fs/variants/interceptors support from generic hooks | V01, V29 |
| Distribution | Clean consumer environment, required runtime files/exports/dependencies, Pi CLI regression, reproducible Git installation, no credentials/fixture keys in artifact | V28, V29 |

Use pairwise compatibility coverage where dimensions are independent, then targeted cross-feature cases at known interaction risks. Do not multiply every protocol method by every transport/provider/platform without a reason. Every advertised transport still gets a real harness round trip and recovery check; feature-specific streaming/auth behavior gets its own transport coverage.

## 7. Recovery contract: the critical path

Stable identifiers must distinguish **one intent retried** from **two legitimate intents**. Bind operation identity to storage/session identity, conversation, durable invocation/nested-call key, configured server/principal and request fingerprint. A conversation number alone is not globally unique. Persisted state from another database/configuration must not be accepted merely because numeric IDs match.

For a same-intent retry, reuse the known remote Task/reference/result. For a changed body under the same external request ID, either the host rejects it or the explicit host contract explains the lower-level dedup behavior; do not silently replay a result for a different user action. Never derive a retry key from the attempt timestamp.

Recheck authorization at the external operation boundary during replay. A saved approval cannot bypass later revocation or silently authorize a changed server/schema. For an uncertain effect, block automatic reissue even if the model creates a *new* tool invocation for the same pending action; resolve or request an explicit reconciliation decision. Demonstrate the actual policy without claiming semantic deduplication of every imaginable natural-language request.

Uncertainty must have a usable exit path. A trusted host decision can record a server-confirmed outcome, authorize retry after confirmed non-execution, explicitly authorize a duplicate-risk retry when certainty is unavailable, or abandon/cancel the intent with an honest unresolved/cancelled status. Do not call an operator's guess a server-confirmed result or silently make abandonment look successful. Bind the decision to intent, evidence, principal and request fingerprint; repeat/conflicting/late answers follow the same idempotency and authorization rules as other decisions. V05 proves the public host operation; V14/V24 prove the remote-human path across restart. No automatic retry is authorized merely by the existence of this interface.

| Interruption point | Required observable outcome |
|---|---|
| Before event acceptance | No success ACK; server may redeliver |
| Accepted event, before Durable submission | Pending event survives; recovery admits it |
| Submission committed, before ID returned | Same request ID resolves to the existing submission |
| Before remote tool request | Pending intent is visible; no remote side effect has occurred |
| Remote effect applied, response lost | Mark outcome unknown; reconcile using a server-supported key/handle if available; never blindly repeat |
| Remote Task handle received, before recovery record committed | Exercise the unavoidable uncertainty window; do not claim a recoverable handle that was not stored |
| Task reference stored, before local result | Resume the same remote Task, not another `tools/call` |
| Input decision accepted, response/update lost | Reuse its correlated decision; late/conflicting answers cannot authorize a new operation |
| Model/outer code-mode process killed mid-run | Native journal reuses committed nested results; interrupted calls follow their actual replay policy |
| Durable submission done, before inbox ACK | Recovery observes done and ACKs without another model run |
| ACK/cursor persistence interrupted | No accepted event is lost; duplicate delivery remains idempotent at admission |
| Storage write/flush fails | No visible committed success based only on memory; retain prior recovery state and expose failure |

Run each meaningful failpoint in a **separate worker process**, use a fixture barrier to place the failure deterministically, kill only the recorded child PID, then launch a fresh worker against the exact retained files. A process supervisor controls crashes; no sleeps guessed to land inside a race. Keep the fixture server/effect ledger outside the killed worker. Test server failure independently too.

For Events, distinguish ingress acceptance, agent admission, generation completion and domain-action success. A submission can finish after a tool error; “done” is not proof every requested business effect succeeded. Define the documented event disposition for model/provider failure, unsafe interrupted tools and poison events. Pending work must be inspectable and retryable, while one bad event must not silently starve unrelated subscriptions. Do not invent exactly-once business effects from event deduplication.

For Tasks, notifications can update status; polling remains a valid independent recovery path. Notification support is not the same feature as MCP Events, and Events are not a substitute for a remote Task reference.

## 8. Human interaction, sampling, Skills and Apps

### Host interaction contract

A headless service cannot depend on `ctx.ui.select`, opening the server's browser, or a terminal prompt. Reuse the existing host-managed interfaces where possible. Define a small, authenticated pending-decision interface that includes conversation, operation, server/origin, requested scope, expiry and stable decision identity. Persist enough to survive disconnect/restart without storing credentials or granting new permissions. An absent client means pending/denied according to explicit policy, never auto-approved by accident.

Test two clients attached to the same conversation, a foreign client, a stale response, repeated identical response, conflicting response, cancellation while waiting, and a response after the original operation ended. A server's instruction text or an event cannot approve its own action.

### Sampling

Exercise an MCP request that causes a **real nested Gemini generation through Pi's model/harness facilities**, including a tool-using sampling loop if supported by the host contract. Do not fulfill it with a canned string or a direct unrelated HTTP completion. Preserve the distinction from the primary conversation: sampling is server-requested model work, not automatically a new user turn.

Choose and verify the smallest durable representation of the nested work. It must not deadlock the main conversation that is waiting for the MCP tool. Bind retries/cancellation, context permissions, selected model, budgets and output review to the original request. Inspect parent transcript, child/task evidence and provider requests to prove isolation and accounting. Test no-tools and tools, model hints/limits, denied context, revoked permission, timeout, recursive requests and upstream disconnect. Modality-specific rejection is lower priority than execution/recovery, but never silently coerce unsupported content.

### Skills

Verify both the wire contract and **activation in the real Durable context**. Fetching a `SKILL.md` resource is not proof it was activated. Static-manifest changes revoke consent; dynamic content cannot inherit blanket persisted approval. Fork/reset/compaction/reopen must not turn origin-tagged remote material into a trusted local skill or broaden `allowed-tools`. Cached or materialized support files must preserve origin and integrity. A test should use a server-controlled nonce instruction that affects a permitted real action, while an unapproved action remains blocked.

### Apps

A returned HTML string or URL is not a rendered App. Run an actual sandboxed browser host. Trace: model calls native code mode → MCP tool → UI resource → initialized frame → user interaction → authorized MCP tool/Task → updated committed conversation and UI. Test both model-visible and app-only tools, event-driven updates, reconnect, reload, CSP/origin denial, cancellation, stale UI sessions and cross-conversation attempts. Control one shared effect path so UI calls cannot bypass the recovery/approval rules used by agents.

The acceptance client is real but deliberately small. Do not build native iOS/Android apps to prove the host contract, and do not call browser-only proof native-mobile compatibility.

## 9. Execution order and checkpoints

Detailed proposed tasks, acceptance criteria, files and verification are in [todo.md](todo.md). The critical chain is:

```text
V01 contract/inventory → V02 independent acceptance apparatus → V03 native host
  → V25 exclusive ownership/state identity
  → V04 native code-mode parity → V05 remote Task/effect recovery
  → V06 event admission/ACK crash recovery → checkpoint A

After the shared identities/policies are stable:
  Events modes (V07–V09), data surfaces (V10–V11), Tasks input (V12),
  sampling/human/Skills (V13–V16), auth/transports (V19–V21)
  → Apps (V17–V18), lifecycle/isolation/client (V22–V26)
  → checkpoint B → bounded recovery soak (V27)
  → clean distribution (V28) → independent final acceptance (V29)
```

The exact DAG, not these grouped ranges, determines readiness. Shared manager/policy/schema changes have one owner. Independent fixtures, reviews and already-defined slices may run in parallel. Do not let agents implement competing identity or consent contracts. Preserve each candidate/failure; integrate and verify a coherent tree before another cohort.

Checkpoints:

- **A — trustworthy recovery spine:** real model and deterministic crash tests prove tools, native code mode, Tasks identity and event ACK semantics. Do not port every feature before this passes.
- **B — complete host surface:** every required capability is reachable through the Durable host, including human/browser interactions; cross-feature attacks and cancellation pass.
- **C — shippable evidence:** installed artifact and exact committed source pass regression, wire, real Gemini, browser, crash and resource gates; independent review reproduces the decisive paths.

## 10. Commands and runtime discipline

Existing commands, verified from `package.json` (listed here; not rerun during planning):

```sh
bun install --frozen-lockfile
bun run typecheck:durable
bun run test:durable
bun run prototype:durable
bun run typecheck
bun run typecheck:native-codemode
bun run build:public
bun run test:vitest --maxWorkers=2 --minWorkers=1
bun run test:oauth
bun run test:public-exports
bun run test:conformance
bun run test:live-gemini
bun run test:live-events-modes
bun run test:live-task-trust
bun run test:live-codemode-tasks
bun run test:live-codemode-events-skills
bun run test:live-codemode-apps
bun run verify:complete
node verification/github-install.mjs
```

The full inherited suite has an interactive-visualizer build prerequisite documented in `COMPLETE.md`; retain it in the runner. Existing `verify:complete` does not establish the new Durable acceptance matrix by itself and omits the Durable suite. The root auth-extension test is also not selected by the inherited Vitest/OAuth scripts. V02/V29 will add a proposed `bun run verify:durable` orchestrator and scoped contract/crash/live/browser lanes; these commands **do not exist yet**. It must exit nonzero on missing required scenarios, unexpectedly unselected tests, unexpected skips, changed source, missing evidence or a failed oracle—not merely on subprocess crashes. Reconcile stale conformance narrative with the executable baseline without weakening issuer validation to improve a score.

Use local Pi/Durable 1.3.0 packages. Current planning host: Node `v24.21.0`, Bun `1.4.3`, macOS arm64. Node remains the tested execution host for the prototype; Bun is the package/task runner. Cross-platform or Cloudflare storage support is a separate claim, not inferred from upstream exports.

Use the existing managed Gemini credential, resolved through the established file/provider store; do not ask Charles for a key or log it. Freeze the selected available model before a cohort; the prior run used `google/gemini-3.8-flash`. Record provider version/alias uncertainty rather than silently substituting a model. No live model calls are needed to finish this planning turn.

## 11. Evidence, budget and stopping rules

Prefer assertions to judges. Every pass should link the initiating action to wire evidence, durable public state and the independent externally observed outcome. Keep raw sanitized traces outside Git; commit a small manifest and the replay commands. Include source SHA and lockfile/package hashes, skills used, host/runtime versions, transport/fixture/spec versions, exact scenario selection, start/end times, exit status and failures.

For real-model runs collect input/output/cache tokens, provider/tool usage, retries and cost when available. Missing fields are unknown, never zero. For load/soak collect whole process-tree CPU, sampled peak memory, post-teardown state, I/O, disk growth, child processes, ports and queue depths. Do not label the prototype's main-process-only resource record a capacity measurement.

Before executing a cohort:

1. Measure allocated DB/WAL/inbox/artifact sizes and available space. Planning observation: the existing sibling evidence directory was about 24 MiB, prototype source about 52 KiB, filesystem reported about 170 GiB available; remeasure at launch.
2. Establish per-attempt and total disk/time/provider-call limits from a single measured calibration run. Enforce them before spawning more workers or copying state. All runs have timeouts and bounded retries.
3. Start real-model acceptance serially; increase concurrency only after measured single-worker demand. Independent read-only planning audits are not a capacity benchmark.
4. Retain failed/cancelled attempts with IDs. Avoid unbounded repeated full SQLite copies. Back up the matching Durable and Frontier stores as a set after stopping writers; include WAL-related state and test an actual restore.
5. Archive completed evidence efficiently. Delete nothing material until archive inventory, restore and independent review establish recoverability. No cleanup targets may be broad workspace/home directories.

Stop a run—not the whole project—on source drift, unavailable credentials, denied consent, state identity mismatch, exhausted budget, unexplained skips or corrupt evidence. Diagnose and preserve the failure. A change to the apparatus starts a new cohort. Do not spend extra live calls to hide a nondeterministic failure.

For release reliability, predeclare repeated runs and seeds after calibration, show every attempt, and obtain a separately prepared reproduction. Repetition within one cohort is not independent replication. Time/cost estimates remain measured outputs; the single old 18.5-second demo is not a delivery estimate for this plan.

The execution runner/orchestration must automatically advance a completed candidate to independent verification and then a retained checkpoint; do not wait for a user reminder or equate a worker's success exit with acceptance. Record reviewer model/harness identity and any unavailable diversity. Read the resulting cleaned trajectory before proposing method changes. Skills remain unchanged unless a concrete observed miss justifies a separately measured revision.

## 12. Release gate and remaining decisions

Completion requires all of the following:

- Required coverage ledger rows pass, with no feature downgraded to excluded/N/A without approval.
- Stock Pi Durable + real Gemini + installed Frontier artifact completes the combined journey: discover/authorize → run native code mode → MCP Task with human input → process kill/recover → Events wake in all supported modes → approved Skill use → sampling → real App interaction → client reconnect → final result and accounting.
- Independent peer effects and public durable state agree; unknown outcomes are safely surfaced; no fabricated exactly-once or power-loss claim.
- Deterministic tests prove security, fault ordering and negative cases; genuine model/browser tests prove the actual agent/client integration. Both are required.
- Existing ordinary-Pi regression protection remains. Legacy issuer-validation conformance disagreement and platform skips are adjudicated openly, not silently counted as full conformance.
- Public export/install docs match the delivered artifact; clean GitHub install works without prototype-relative imports or editing Pi. An npm publish or production deployment remains a separate explicit action.
- A fresh independent reviewer verifies the exact source/artifact and reruns decisive cases. Prefer a different model/harness when available and authorized; record the actual identity and do not claim diversity that was unavailable.
- Recovery, operator decisions, retention, version policy and remaining genuine platform/provider limits are documented. All tracked work is committed and pushed without squashing.

Decisions for review: approve the five seams and capability scope; accept a native shared-engine adapter as the initial approach; retain Node/SQLite as the first supported host; use one service contract plus a real browser acceptance client. Technical questions—exact native effect key, hook/decision resume representation, independent-store reconciliation, App routing—are answered by the early tracer bullets, not by asking Charles to design the implementation.

## 13. Primary specification pointers

- [MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28) and [extension negotiation](https://modelcontextprotocol.io/extensions/overview).
- [Tasks overview](https://modelcontextprotocol.io/extensions/tasks/overview); historical audit anchor `ext-tasks@899c1bbc869567670093face3591b39c28ce3219`.
- [Skills overview](https://modelcontextprotocol.io/extensions/skills/overview); historical stable-spec audit anchor `ext-skills@c1aa87e4c381c82b99aa37471d0eae4ab50f9985`.
- [Apps overview](https://modelcontextprotocol.io/extensions/apps/overview); pin the actual Apps specification/SDK version in V01.
- [Events draft](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/d5316be214be2e76e51462069c1d67e00a5a7619/docs/design-sketch-proposal.md), explicitly experimental.
- [Pi Durable tagged README](https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/README.md), checked against the installed `@earendil-works/pi-durable@1.3.0` README/dist. Freeze installed package integrity; a version label alone is insufficient provenance.

Planning verification consists of source inspection, matching the three prototype source hashes to retained evidence, skill-directed decomposition and independent source-audit review. It is **not** a new product acceptance run. Skills are used unchanged; this plan makes no RSI improvement claim.

The document review identified four actionable omissions: operator completion of uncertain-effect reconciliation, missing Events→Apps→conversation-isolation dependencies, overly broad storage/reliability work, and absent lazy-startup/context-cost gates. The draft now includes each correction, with V25/V27 split into five named child slices. Structural checks confirm 29 work-package IDs, an acyclic dependency graph, reachability of every work package from the final gate, matching dependency metadata and valid local links. Reviewers were independent agents with the inherited model, not a claimed different-model evaluation. Product acceptance remains unrun.

Requested router provenance (SHA-256): Addy `0.1.0` / `using-agent-skills` = `30787ef2c77bf1a4729fffed0f6523ba6fcbe81bdc436b36371b78c21394d3c3`; Matt `1.3.1` / `ask-matt` = `b67d915ba96664c713c9392bcfd62cfeff71b340fe4fae5f94a744ca0d76e35c`. Both are retained unchanged.
