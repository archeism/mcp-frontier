# MCP Frontier × Pi Durable: proposed execution tasks

Status: **draft; all implementation/acceptance tasks are unstarted**.
Contract: [plan.md](plan.md). Baseline: `03ec00c1a10e4845516c886213098a4ae1bb0059`.

## How to execute this list

Approve the five public seams and scope before RED/GREEN work. The numbers are stable coverage IDs, **not execution order**. Follow the dependency graph below. Each task closes a public user/host journey, not an isolated helper. Verification is through S1–S5 in the plan; private-state inspection is diagnostic only.

This list assumes reuse of Frontier's existing engines. File lists are likely touch points, not instructions to create every named abstraction. `durable.ts` is the proposed entry point; `verification/pi-durable/` is a proposed acceptance directory. A slice is provisionally Medium (3–5 files); if the implementation needs more than five files, multiple independent contracts, or more than one focused session, split that task into named child slices **before** implementing it. Keep the parent ID as the coverage group; do not hide an entire rewrite inside one checkbox.

In verification lines below, **planned lane** means the proposed command `bun run verify:durable --scenario Vxx` (using the actual ID). It does not exist today. V02 defines its CLI and fixtures, and later slices add scenarios incrementally. A lane may pass for its selected scope; only the final unfiltered gate certifies the full ledger. Existing commands are called out explicitly. Any command syntax change updates this list and the runner together.

For each task: one public behavior RED → minimal GREEN → focused regression → independent verification → commit/checkpoint. Preserve failed attempts. After every 2–3 completed slices, run the accumulated contract suite and type checks, inspect resource cleanup, and report the verified checkpoint before continuing. Human approval is needed for scope/architecture departures, not repeated approval for every ordinary implementation step.

### Dependency graph

| Task | Depends on | Demoable result |
|---|---|---|
| V01 | None | Frozen requirements, seams and truthful coverage inventory |
| V02 | V01 | A failing integration cannot be reported green |
| V03 | V02 | Clean native host installation makes one MCP call |
| V25 | V03 | One owner, correct state identity, safe process restart |
| V04 | V03 | Direct and native-code-mode calls preserve the same contract |
| V05 | V04, V25 | A killed tool invocation resumes/reconciles its remote effect |
| V06 | V05 | A killed event handler loses no accepted event |
| V20 | V03 | Every retained transport negotiates and reconnects correctly |
| V09 | V06 | Busy agents and bad events do not lose unrelated work |
| V07 | V06, V20 | Push event wakes a real agent after reconnect |
| V14 | V05 | A remote human can safely answer a durable decision |
| V19 | V14, V20 | Service-hosted OAuth works without a server-side terminal |
| V08 | V06, V19, V20 | Authenticated HTTPS webhook survives restart/renewal |
| V10 | V04, V20 | Tools/resources preserve content and subscription behavior |
| V11 | V10 | Prompts, completion and roots work through the actual host |
| V12 | V05, V14 | A remote Task awaiting input completes after reconnect |
| V13 | V14, V05 | An MCP server triggers genuine isolated Pi/Gemini sampling |
| V15 | V10 | A remote Skill is retrieved and verified without activating it |
| V16 | V15, V14 | Only an approved Skill affects the durable agent context |
| V17 | V10, V14, V19 | A real sandboxed MCP App loads and talks to its host |
| V18 | V17, V05, V06 | An App action uses the same durable effect path as the agent |
| V21 | V19 | Noninteractive auth survives token/secret changes safely |
| V22 | V06, V14, V16, V18 | Forks/children cannot steal another conversation's work |
| V23 | V04, V22 | Reload/reset/compaction preserve the correct runtime contract |
| V24 | V09, V12, V13, V16, V18, V19, V22 | A reconnecting frontend can complete the whole interaction |
| V26 | V07, V08, V11, V12, V13, V16, V18, V21, V23, V24, V25 | Cross-feature attacks fail at the actual effect boundary |
| V27 | V26 | Recovery and resource use stay bounded over repeated operation |
| V28 | V27 | A clean consumer installs the exact verified artifact |
| V29 | V28 | Independently reproduced full E2E acceptance |

V20 and independent fixture/review work may proceed beside the recovery chain. Human/Skills, Events and data-surface lanes may proceed in parallel once their listed contracts are stable. Changes to the same manager, policy or identity contract have one owner and coordinated integration.

## V01 — Freeze the acceptance contract

Turn the plan's family ledger into source-linked requirement rows for the installed Pi/Durable 1.3.0, MCP SDKs, modern/legacy core protocol and each retained extension revision. Compare current upstream specifications with the existing audits; classify additions instead of silently widening a moving target.

**Acceptance:**
- [ ] Charles has approved S1–S5 and the target scope; every required row has a source, host entry point, expected public behavior, task owner and intended evidence layer.
- [ ] All exported/advertised Frontier paths and Durable lifecycle contracts map to rows, including fs/variants/interceptors status, script/Jev versus native code mode, server-only obligations and provider limitations.
- [ ] Source/package/spec hashes and the historical-versus-current evidence distinction are recorded; missing requirements block completion rather than disappear into N/A.

**Verification:** Review installed artifacts/lockfile and primary specs; reconcile the inventory against exports, method/capability registrations and existing test selection. No model calls.
**Likely files:** `tasks/plan.md`, `tasks/todo.md`, proposed `verification/pi-durable/requirements.json`, proposed `docs/pi-durable.md`.
**Size:** Medium. **Dependencies:** None.

## V02 — Establish a trustworthy acceptance runner

Create one small vertical demonstration using the real harness, an independent SDK peer/effect ledger and an external worker supervisor. Prove the apparatus detects a failure before trusting product results.

**Acceptance:**
- [ ] A deliberately missing effect, bad response and killed worker produce nonzero verdicts with preserved attempt evidence; a successful launch alone cannot pass.
- [ ] Selected requirement rows must execute; absent tests, unexpected skips, source drift and missing artifacts fail. The inherited Durable/auth-extension selection omissions are exposed by a regression check.
- [ ] Worker PIDs, transport barriers, timeouts, sanitized traces and resource limits are controlled externally; scenario results identify real-model versus faux-provider evidence honestly.

**Verification:** Planned V02 lane, including injected failing apparatus self-tests; existing `bun run typecheck:durable`. Wire the root `mcp-auth-extensions.test.ts` into its correct Node-test lane rather than assuming Vitest can run it.
**Likely files:** `package.json`, `verify-complete.mjs`, proposed runner, proposed worker fixture, proposed independent peer fixture under `verification/pi-durable/`.
**Size:** Medium; split runner and fixture sub-slices if the measured change exceeds five files. **Dependencies:** V01.

## V03 — Install a native Durable adapter

Load the shared engine through a native Durable registry extension and perform one real peer call from an installed package. Start from the prototype's working path, not a CLI `ExtensionAPI` shim.

**Acceptance:**
- [ ] Consumer import/install/open/attach/call/close works on stock Pi Durable 1.3.0 without editing upstream source; clear runtime/dependency errors are observable.
- [ ] Configuration/roots are explicit and operator-approved; idle install/open starts no unnecessary server/connection. Only demanded work, persisted recovery and active subscriptions justify startup connections; policy/recovery attachment precedes scheduling.
- [ ] Close during connection or work releases listeners, transports and child processes without accidentally terminalizing durable pending work; a fresh process can reopen it.

**Verification:** Planned V03 lane; existing `bun run typecheck:durable`, `bun run test:durable`; inspect a packed native import and measure startup time/processes/connections against the frozen baseline. First real Gemini tracer bullet uses the same published-facing path.
**Likely files:** proposed `durable.ts`, `server-manager.ts`, `package.json`, `tsconfig.pi-durable.json` if needed, proposed `verification/pi-durable/install.ts`.
**Size:** Medium. **Dependencies:** V02.

## V25 — Enforce state ownership before recovery

Protect the supported host's Durable and Frontier state as one logical deployment identity. Upstream supplies no cross-process lock; choose the smallest enforceable owner mechanism rather than assuming one exists.

**Acceptance:**
- [ ] A second writer is rejected before scheduling/effects; a dead owner's state can be safely reopened, with tests for stale ownership and startup failure cleanup.
- [ ] A reused numeric conversation ID in a foreign database, copied sidecar, changed server/principal or mismatched state generation cannot resume another operation or event.
- [ ] Public startup/write/reopen behavior fails closed on incompatible format, corrupted/quota-limited state or interrupted writes; evidence claims process-crash safety only, not power-loss durability.

**Verification:** Planned V25 lane with separate worker processes and constrained temporary state; inspect public errors and the independent effect ledger. Preserve failed stores for diagnosis.
**Likely files:** proposed `durable.ts`, `task-recovery-store.ts`, `mcp-events-registry.ts`, proposed `verification/pi-durable/ownership.ts`, proposed `docs/pi-durable.md`.
**Size:** Split work package; both child slices below must pass. **Dependencies:** V03.

### V25a — Exclusive owner and deployment identity

- [ ] Acquire ownership before scheduling; reject a concurrent writer and recover a dead owner without stealing a live owner's state.
- [ ] Bind sidecars to deployment/database/server/principal identity; foreign or copied state cannot resume effects merely because local IDs match.

**Verification:** Planned V25 ownership sub-lane; two real worker processes and public rejection/reopen observations. **Dependencies:** V03.
**Likely files:** proposed `durable.ts`, `task-recovery-store.ts`, `mcp-events-registry.ts`, proposed `verification/pi-durable/ownership.ts`. **Size:** Medium.

### V25b — Storage-failure behavior

- [ ] Incompatible format, corrupt state, quota/full-disk and interrupted commit fail through public operations without fabricated success or loss of previously accepted work.
- [ ] Fresh-process recovery demonstrates the documented process-failure boundary; no test result is labeled power-loss safety.

**Verification:** Planned V25 storage-fault sub-lane using constrained temporary storage and deterministic barriers. **Dependencies:** V25a.
**Likely files:** proposed storage-fault fixture, proposed `verification/pi-durable/storage-faults.ts`, owning persistence module if a demonstrated fix is needed, proposed operations documentation. **Size:** Medium.

## V04 — Preserve the tool contract through native code mode

Use the same approved tool path directly and through native Durable code mode. Keep runtime exposure distinct from permission to call a tool.

**Acceptance:**
- [ ] With native-code-mode-only configuration the actual Gemini request advertises exactly one top-level tool, while approved nested MCP calls work and forbidden/raw paths cannot bypass policy.
- [ ] Schemas, pagination/change notices, structured/content/error envelopes, output limits, cancellation and usage attribution remain correct across direct/deferred/proxy exposure modes retained by V01.
- [ ] Sequential/parallel nested calls use native journaling and report replay mismatch clearly. If `mcp_script`/Jev are retained, their distinct host/context/classifier permissions are explicitly tested, not assumed equivalent to native code mode.

**Verification:** Planned V04 lane plus real Gemini nonce computation; measure actual declaration bytes/token cost against the baseline and V01's agreed overhead budget. Existing `bun run typecheck:native-codemode`, relevant `test:vitest` tests and `bun run test:durable` remain regression checks.
**Likely files:** proposed `durable.ts`, `tool-registrar.ts`, `tool-approval.ts`, proposed `verification/pi-durable/tools.ts`, proposed `verification/pi-durable/live.ts`.
**Size:** Medium; split legacy script parity into a child slice if retained and not already satisfied. **Dependencies:** V03.

## V05 — Recover a remote tool effect without blind replay

Bind native invocation/nested-call identity to Frontier's remote Task recovery store and an explicit unknown-outcome contract. This is the central feasibility experiment.

**Acceptance:**
- [ ] Kill before send, after remote effect/response loss, after Task handle persistence and before local result; a known handle resumes the same Task and an unknown outcome is visible rather than blindly repeated.
- [ ] Same-intent retries recover the prior outcome; conflicting request bodies/server identities are rejected. A public, authorized reconciliation operation can record confirmed outcome/non-execution, explicitly authorize duplicate-risk retry, or abandon with honest status; repeat/conflicting decisions remain safe across restart and the model cannot bypass unresolved intent by creating a fresh call.
- [ ] Revoked authorization is enforced at the execution boundary during recovery, including native safe-tool replay that bypasses `beforeTool`; immediate results, remote errors, expiry and cancellation preserve truthful status.

**Verification:** Planned V05 deterministic crash lane, then a genuine Gemini/native-code-mode Task killed and reopened in a new process. Independent peer ledger proves effect count and intent correlation; model request retries/cost are separately reported.
**Likely files:** proposed `durable.ts`, `server-manager.ts`, `task-recovery-store.ts`, proposed `verification/pi-durable/recovery.ts`, proposed `verification/pi-durable/peer.ts`.
**Size:** Medium; if shared recovery needs redesign, stop and split the proven incompatibility into child slices. **Dependencies:** V04, V25.

## V06 — Recover event admission and ACK ordering

Run the full poll-event path across independent process failures, replacing graceful reopen as the acceptance proof.

**Acceptance:**
- [ ] Each cut between ingress persistence, submission commit, result completion and ACK/cursor commit preserves accepted work and reuses its stable submission identity.
- [ ] Repeated delivery after committed completion causes neither another Gemini request nor another domain effect; conflicting duplicate payloads fail explicitly.
- [ ] Provider failure, tool failure and interrupted unsafe effects have documented pending/retry/reconciliation dispositions. Submission `done` is not mistaken for successful business action.

**Verification:** Planned V06 barriers/kill matrix plus real Gemini idle wake and fresh-process replay; existing prototype ACK test remains supporting evidence only.
**Likely files:** proposed `durable.ts`, `mcp-events-inbox.ts`, `mcp-events-coordinator.ts`, proposed `verification/pi-durable/event-recovery.ts`.
**Size:** Medium. **Dependencies:** V05.

### Checkpoint A — Recovery feasibility

- [ ] V03–V06 and V25 pass on stock Durable, with independent effects, real Gemini evidence and a new OS process after each crash.
- [ ] Core identity/authorization/unknown-outcome contracts are reviewed and checkpointed before broad feature porting.
- [ ] If the shared implementation cannot meet a requirement, retain the failing reproducer and present the smallest adapter/shared-core/upstream change; do not fork speculatively.

## V20 — Verify every retained transport and protocol generation

Put the native host over each advertised transport and exercise modern/legacy negotiation. These tests establish connectivity, not every feature combination.

**Acceptance:**
- [ ] stdio, HTTP, retained SSE and Unix paths each perform a real harness round trip, error and recovery; unsupported transports fail explicitly rather than being advertised.
- [ ] Modern per-request capabilities/discovery, legacy initialization, pinned versus automatic fallback and stale metadata behave according to the frozen specification; unsupported method/extension requests cannot force unsafe fallback.
- [ ] Reconnect/session expiry, timeout/cancel/progress, process exit, TLS/custom CA/proxy behavior and cleanup have transport-appropriate observations without logging secrets.

**Verification:** Planned V20 lane; existing runtime transport/HTTP CA tests and conformance cases as regression. Test stream-specific semantics on streaming transports, not only a generic echo.
**Likely files:** `server-manager.ts`, `config.ts`, proposed `verification/pi-durable/transports.ts`, proposed `verification/pi-durable/peer.ts`.
**Size:** Medium. **Dependencies:** V03.

## V09 — Deliver events to a busy agent safely

Specify event admission during an active turn and isolate malformed or oversized events so one subscription cannot starve the others.

**Acceptance:**
- [ ] Queue/steer/reject policies are explicit; concurrent valid events reach the correct conversation in the permitted order without crossing permissions or losing cursors.
- [ ] Poison/oversized/schema-invalid events have a visible disposition and bounded retry; a valid sibling subscription still progresses.
- [ ] Cancellation, shutdown with queued work and reopen retain pending work under bounded ingress/backpressure policy; no silent dropping or unbounded memory growth.

**Verification:** Planned V09 lane with deterministic busy-turn barriers and a real Gemini busy/idle transition.
**Likely files:** proposed `durable.ts`, `mcp-events-coordinator.ts`, `mcp-events-inbox.ts`, proposed `verification/pi-durable/event-queue.ts`.
**Size:** Medium. **Dependencies:** V06.

## V07 — Deliver push events after reconnect

Expose the existing push engine through the native host and prove its recovery and scheduling behavior.

**Acceptance:**
- [ ] Negotiated activation/heartbeat/push messages lead to a genuine idle-agent wake and an independently checked domain result.
- [ ] Disconnect/reconnect, replay/cursor changes, duplicates and long quiet periods neither lose accepted events nor fabricate new events.
- [ ] Unsubscribe/expiry/shutdown stop the correct stream without cancelling sibling subscriptions; foreign events cannot enter another conversation.

**Verification:** Planned V07 lane, real Gemini push wake, peer wire trace and fresh-process recovery. Existing normal-Pi event-mode runner remains a separate regression.
**Likely files:** proposed `durable.ts`, `mcp-events-coordinator.ts`, proposed `verification/pi-durable/events-push.ts`.
**Size:** Medium. **Dependencies:** V06, V20.

## V14 — Persist and answer human decisions

Provide the smallest service-facing decision contract for tool approval, context disclosure and MCP elicitation without terminal UI. Reuse it for later Tasks, Skills, auth and Apps.

**Acceptance:**
- [ ] Form/URL requests are correlated with conversation, operation, origin, scope and expiry; accept/decline/cancel plus defaults/validation produce the correct peer response.
- [ ] Restart/client disconnect leaves pending decisions inspectable, including V05's uncertain-effect reconciliation. A remote operator can resolve or explicitly abandon the intent; duplicate identical answers are idempotent and conflicting/stale/foreign answers cannot grant authority.
- [ ] No-client policy is explicit; cancellation/revocation/late completion cannot revive an ended operation. Auto-approval of one capability does not imply consent to context sharing or another capability.

**Verification:** Planned V14 lane using a real authenticated test client, negative identity cases and a genuine agent tool→elicitation→response journey. No requirement for the complete V24 frontend yet.
**Likely files:** proposed `durable.ts`, `elicitation-handler.ts`, `tool-approval.ts`, proposed `verification/pi-durable/decisions.ts`, proposed `docs/pi-durable.md`.
**Size:** Medium. **Dependencies:** V05.

## V19 — Complete interactive OAuth from a service client

Remove any assumption that the service operator can click a terminal prompt or open a local browser on the server.

**Acceptance:**
- [ ] Retained discovery/resource/issuer/DCR/CIMD/PKCE flows use a client-visible, correlated pending interaction; authenticated callback/state processing completes the original MCP operation.
- [ ] Restart while waiting, expired/foreign/replayed callback, refresh and scope escalation obey the same durable decision and principal boundaries.
- [ ] Tokens/codes/verifiers stay out of model context, browser-accessible host state and logs; stricter issuer checks are preserved and conformance disagreements are recorded truthfully.

**Verification:** Planned V19 lane with independent OAuth fixture and browser callback; existing `bun run test:oauth` and auth conformance regression. Live third-party accounts are not required for malicious-server cases.
**Likely files:** proposed `durable.ts`, `mcp-auth-flow.ts`, `mcp-callback-server.ts`, proposed `verification/pi-durable/auth.ts`.
**Size:** Medium. **Dependencies:** V14, V20.

## V08 — Accept authenticated HTTPS webhook events

Connect the webhook listener/receiver lifecycle to durable state and the same event admission path used by poll/push.

**Acceptance:**
- [ ] A real HTTPS request with verified raw-byte signature/auth causes a genuine agent wake; invalid signatures, replay conflicts, wrong subscriptions and excessive bodies are rejected before admission.
- [ ] Pending-secret activation, renewal/expiry/rotation, unsubscribe and process restart retain correct subscription identity and cursor/ACK semantics.
- [ ] Receiver failure and offline recovery do not silently claim delivery; routes/ports/secrets are released or retained according to the declared lifecycle.

**Verification:** Planned V08 lane with loopback HTTPS/trusted test CA, renewal and kill barriers, plus real Gemini webhook wake. This proves the service contract, not deployment through an untested public ingress provider.
**Likely files:** proposed `durable.ts`, `mcp-events-webhook.ts`, `mcp-events-listener.ts`, `mcp-events-coordinator.ts`, proposed `verification/pi-durable/events-webhook.ts`.
**Size:** Medium. **Dependencies:** V06, V19, V20.

## V10 — Preserve tool/resource content through the host

Exercise rich MCP responses and resource operations through native calls and code mode, not just SDK serialization tests.

**Acceptance:**
- [ ] Tool envelopes and resource list/read/template expansion/pagination preserve structured data, annotations, URI/origin, text and supported binary content; malformed/oversized content fails safely.
- [ ] Resource subscription/change notifications survive reconnect without leaking across conversations; stale cache/schema state cannot silently change permissions.
- [ ] Private materialization and URI/read policy also apply to nested code-mode and UI/support-resource reads. Unsupported provider modalities are explicit, not falsely reported as understood.

**Verification:** Planned V10 lane with nonempty templates and independent resource bytes; genuine Gemini consumes a resource-derived nonce to perform a permitted action. Existing resource/Skills boundary tests remain.
**Likely files:** proposed `durable.ts`, `mcp-core.ts`, `server-manager.ts`, proposed `verification/pi-durable/resources.ts`.
**Size:** Medium. **Dependencies:** V04, V20.

## V11 — Expose prompts, completion and workspace roots

Give the native host the remaining core data operations with explicit workspace identity and version-appropriate utilities.

**Acceptance:**
- [ ] Prompt list/get/arguments/change notices and completion return correct content through public host paths, including malformed/unsupported and pagination cases.
- [ ] Roots reflect the configured conversation workspace, never the service process's incidental cwd; changes/denials preserve origin and access boundaries.
- [ ] Ping/logging/progress/cancellation are handled or rejected according to protocol generation, and correlation cannot settle a different call.

**Verification:** Planned V11 lane with peer-observed roots and real Gemini prompt-assisted action; inherited core tests plus modern/legacy negative tests.
**Likely files:** proposed `durable.ts`, `mcp-core.ts`, `server-manager.ts`, proposed `verification/pi-durable/core.ts`.
**Size:** Medium. **Dependencies:** V10.

## V12 — Resume Tasks that require human input

Route remote Task state and input requests through the same durable intent/decision identities, preserving polling as a recovery path.

**Acceptance:**
- [ ] Working/input-required/terminal/error results, poll hints, TTL and task input updates preserve modern/legacy semantics and known-handle authorization.
- [ ] A Task paused for input survives client/worker disconnect; one accepted decision resumes the same remote Task, not a replacement call.
- [ ] Status notifications, polling, cancellation races, expired handles and notification loss cannot fabricate success or change task ownership; status notification support is distinguished from Events.

**Verification:** Planned V12 lane with actual peer state transitions and genuine Gemini tool→Task→human input→result after fresh-process restart.
**Likely files:** proposed `durable.ts`, `mcp-tasks.ts`, `server-manager.ts`, proposed `verification/pi-durable/task-input.ts`.
**Size:** Medium. **Dependencies:** V05, V14.

## V13 — Run genuine sampling through Pi

Bridge an MCP sampling request to real Pi model/harness facilities, with isolated nested work rather than a fake response or unrelated HTTP completion.

**Acceptance:**
- [ ] No-tools and tool-using requests cause genuine Gemini work with requested limits/model preferences enforced where supported; provider calls and peer results prove the path.
- [ ] Context disclosure/result-review policies bind to the request; nested work does not deadlock the waiting parent or silently become a new main user turn.
- [ ] Restart, timeout, cancellation, recursion, denied context and disconnected servers produce bounded, correlated outcomes; nested usage is recorded without double counting and unsupported modalities fail clearly.

**Verification:** Planned V13 lane plus real Gemini nested-loop evidence, parent/child public transcripts and independent peer assertions. Choose the smallest native representation after a tracer experiment.
**Likely files:** proposed `durable.ts`, `sampling-handler.ts`, `server-manager.ts`, proposed `verification/pi-durable/sampling.ts`.
**Size:** Medium; any new child-work representation gets a separate child slice. **Dependencies:** V14, V05.

## V15 — Verify remote Skill retrieval

Port the existing Skills wire/integrity policy through the native host without conflating discovery with activation.

**Acceptance:**
- [ ] Declaration/list/get/direct lookup plus resource/directory/support-file retrieval honor the frozen static/dynamic spec, manifests/digests/frontmatter and supported size/file bounds.
- [ ] Traversal, Unicode ambiguity, origin/authority substitution, stale caches and changed content fail before unauthorized materialization or disclosure.
- [ ] Retrieval alone does not modify the agent's effective instructions or grant a tool; restored files preserve source identity and integrity.

**Verification:** Planned V15 wire/boundary lane with real storage and an independent SDK peer; reuse existing Skills adversarial fixtures.
**Likely files:** proposed `durable.ts`, `mcp-skills.ts`, proposed `verification/pi-durable/skills-retrieval.ts`.
**Size:** Medium. **Dependencies:** V10.

## V16 — Activate only approved Skills in durable context

Make approved remote Skill content actually affect the native agent while maintaining revocation, provenance and context lifecycle semantics.

**Acceptance:**
- [ ] A genuine Gemini action demonstrates approved Skill use; a fetched-but-unapproved Skill and an out-of-scope supporting tool remain ineffective/blocked.
- [ ] Static changes, dynamic content, nested requests and revoked consent do not inherit stale blanket approval or shadow trusted local skill names.
- [ ] Reopen/compaction/reset/fork retain or clear activation according to the contract without laundering origin or broadening allowed tools; nested code-mode attribution remains correct.

**Verification:** Planned V16 lane with nonce-bearing Skill instructions and separately checked permitted/forbidden effects. Fork-specific combinations are strengthened in V22.
**Likely files:** proposed `durable.ts`, `mcp-skills.ts`, `init.ts` only if a shared context hook must be extracted, proposed `verification/pi-durable/skills-activation.ts`.
**Size:** Medium. **Dependencies:** V15, V14.

## V17 — Render a real MCP App in a service host

Use a minimal browser acceptance client to load a real MCP UI resource and complete the Apps host handshake through the native adapter.

**Acceptance:**
- [ ] UI metadata/content/resource loading, initialization, messages, visibility and context updates are observed in a real sandboxed frame, not inferred from an HTML string.
- [ ] CSP/origin/sandbox and conversation authorization block hostile/foreign frames; disabled/unavailable UI capability is advertised honestly with an explicit fallback.
- [ ] Reload/reconnect/teardown and stale sessions preserve identity, release resources and never expose host credentials; unsupported operations return documented errors.

**Verification:** Planned V17 browser lane with actual rendering, browser-side assertions and saved sanitized evidence. Use an available real-browser skill/tool, not a presumed Chrome plugin.
**Likely files:** proposed `durable.ts`, `host-html-template.ts`, existing Apps host module identified in V01, proposed `verification/pi-durable/apps-browser.ts`, proposed minimal browser fixture.
**Size:** Medium; reuse the existing viewer rather than building a product frontend. **Dependencies:** V10, V14, V19.

## V18 — Reconcile App actions with agent-side effects

Route UI tool actions through the same authorization/recovery boundary as agent calls, including a result produced inside native code mode.

**Acceptance:**
- [ ] Gemini/native-code-mode tool output opens an initialized App; an authenticated UI action performs an approved tool/Task and the UI plus committed conversation reflect its result.
- [ ] Reload, duplicate action, worker kill and result-delivery loss reuse the logical intent or surface uncertainty instead of applying the effect twice.
- [ ] App-only versus model-visible tools, event-driven updates, stale UI actions and cross-conversation attempts respect the declared visibility and permission boundaries.

**Verification:** Planned V18 real-browser/real-Gemini journey plus deterministic effect-loss cuts using the independent peer ledger.
**Likely files:** proposed `durable.ts`, existing Apps action bridge identified in V01, `server-manager.ts`, proposed `verification/pi-durable/apps-effects.ts`.
**Size:** Medium. **Dependencies:** V17, V05, V06.

## V21 — Verify noninteractive auth lifecycle

Carry existing SDK-backed machine-auth modes through the service host, including client credentials, private-key JWT and enterprise modes actually retained in the frozen inventory.

**Acceptance:**
- [ ] Each retained mode performs a real SDK/transport exchange with an independent auth fixture and the intended principal/scopes, rather than only a mocked fetch test.
- [ ] Expiry/refresh races, revocation and secret rotation preserve remote Task/server identity and fail closed when continuation is no longer authorized.
- [ ] No private key/token is shipped in an artifact or echoed to model/client/logs; root auth-extension tests run in the gate and unsupported modes are not advertised.

**Verification:** Planned V21 lane and existing `bun run test:oauth`, augmented with the previously unselected root test and wire-level fixtures. Generate disposable test keys at runtime.
**Likely files:** `mcp-oauth-provider.ts`, `mcp-auth-extensions.test.ts`, proposed `verification/pi-durable/machine-auth.ts`, proposed `verification/pi-durable/auth-peer.ts`.
**Size:** Medium. **Dependencies:** V19.

## V22 — Isolate conversations, forks and children

Exercise upstream ownership semantics where they intersect Frontier state rather than assuming inherited conversation history grants access to remote work.

**Acceptance:**
- [ ] Concurrent conversations and forks have correct fresh/inherited identities; no event, Task, approval, Skill activation or App session is stolen by a sibling with matching local IDs.
- [ ] Owned/background child operations follow native abort/close/stop-resume boundaries; cancelling a waiter is distinct from cancelling work.
- [ ] Fork/rewind and parent/child failure preserve the documented context/policy semantics and release only owned resources; independent peer effects match public task state.

**Verification:** Planned V22 multi-conversation process lane plus one genuine nested-agent/fork scenario where native support permits; source-linked unsupported combinations remain explicit blockers if required.
**Likely files:** proposed `durable.ts`, `task-recovery-store.ts`, `mcp-events-registry.ts`, proposed `verification/pi-durable/isolation.ts`.
**Size:** Medium. **Dependencies:** V06, V14, V16, V18.

## V23 — Preserve lifecycle semantics across reload and context change

Test native registry reload and conversation lifecycle transitions against pending MCP work and security context.

**Acceptance:**
- [ ] Install/reload/uninstall and missing definitions produce correct old-running/new-subsequent behavior or explicit blocked/orphan status; startup does not schedule before recovery policy is ready.
- [ ] Reset/handoff/compaction/stop-resume neither strand decisions silently nor reactivate revoked Skills or lost origin tags; stale summaries cannot broaden permissions.
- [ ] Native-code-mode journal mismatch, schema/code revision and parallel replay fail visibly without creating replacement external effects under a stale approval.

**Verification:** Planned V23 deterministic transition/barrier lane; real Gemini context-compaction and subsequent approved MCP action; public entries/status plus peer effects are the oracle.
**Likely files:** proposed `durable.ts`, `tool-registrar.ts`, `mcp-skills.ts`, proposed `verification/pi-durable/lifecycle.ts`.
**Size:** Medium. **Dependencies:** V04, V22.

## V24 — Complete the service/client reconnect journey

Assemble the already-tested host operations into one small service contract and reconnecting browser/automated client, with no protocol implementation in the frontend.

**Acceptance:**
- [ ] Authenticated clients can submit/reacquire/inspect/watch/cancel and answer decisions; disconnect does not cancel server work, and duplicate request IDs with changed payloads are rejected.
- [ ] Reconnect starts from committed snapshots, not assumed replay of every watch frame; slow consumers, coalesced updates and two simultaneous clients converge on the same durable state.
- [ ] A client completes a Task/decision/Skill/sampling/App/event journey across disconnect and worker restart, including resolution of an uncertain effect; unauthorized clients see no work, credentials or decisions from another conversation.

**Verification:** Planned V24 real client/browser lane with network interruption and >100 queued observer updates; genuine Gemini agent remains server-side. Do not label this native iOS/Android proof.
**Likely files:** proposed service example, proposed browser acceptance client, proposed `verification/pi-durable/service.ts`, proposed `docs/pi-durable.md`.
**Size:** Medium; split client transport from combined journey if implementation exceeds the slice limit. **Dependencies:** V09, V12, V13, V16, V18, V19, V22.

## V26 — Attack cross-feature authorization boundaries

Use hostile peers and clients to test the combinations most likely to bypass otherwise-correct isolated policies.

**Acceptance:**
- [ ] Replay after revocation, changed server/schema, raw SDK access, nested code mode, App actions and resumed Tasks cannot bypass the actual operation-level decision.
- [ ] Remote Skills/events/prompts/resources/App text cannot authorize context disclosure or a foreign action; protected URI/secret data remain inaccessible across transports and conversations.
- [ ] Failure/cancellation paths disclose no secrets, preserve unknown outcomes, and contain poisoned input without disabling unrelated valid work; every retained surface is mapped to a negative case.

**Verification:** Planned V26 adversarial integration lane, independent security review and focused inherited regression tests. Any discovered implementation fix returns to its owning task before this gate reruns.
**Likely files:** proposed `verification/pi-durable/security.ts`, existing malicious peer fixtures, proposed requirements ledger; product fixes are separately owned slices.
**Size:** Medium. **Dependencies:** V07, V08, V11, V12, V13, V16, V18, V21, V23, V24, V25.

### Checkpoint B — Full host surface

- [ ] Every required capability has a reachable native host path, deterministic public contract evidence and an appropriate real-agent/browser scenario.
- [ ] Cross-feature security, identity, lifecycle and cancellation checks pass; no required unsupported row has been relabeled N/A.
- [ ] Independent review confirms the candidate and records remaining provider/platform limits before reliability/distribution work.

## V27 — Bound reliability, resources and retained evidence

Calibrate and execute repeated restart/reconnect/cancellation work, including a real restore of matching Durable/Frontier state.

**Acceptance:**
- [ ] Predeclared attempts/seeds and enforced time/provider-call/disk limits preserve all outcomes; no unbounded queue, listener, process, port, memory or disk growth is hidden by averages.
- [ ] Whole process-tree resource demand and model/cache/retry costs are measured; telemetry correlates event→submission→invocation→remote Task without secret leakage or nested double counting.
- [ ] Stop writers, create a coherent checkpoint, restore it to an isolated location and recover through public APIs; retention/expiry/migration operations preserve pending work and no material evidence is deleted without verified recovery.

**Verification:** Planned V27 bounded soak/restore lane. Start serially, choose concurrency only from measured demand, separate process-crash tests from unclaimed power-loss/distributed failover guarantees.
**Likely files:** proposed `verification/pi-durable/soak.ts`, proposed acceptance runner, proposed `docs/pi-durable-operations.md`, requirements/evidence manifest.
**Size:** Split work package; all three child slices below must pass. **Dependencies:** V26.

### V27a — Measured bounded soak

- [ ] A calibrated, predeclared cohort repeatedly restarts/reconnects/cancels with enforced call/time/disk limits; all failures and seeds remain retained.
- [ ] Whole process-tree demand, queue/listener/port cleanup and model/cache/retry usage demonstrate bounded operation without nested double counting or secret leakage.

**Verification:** Planned V27 soak sub-lane, initially serial; choose further concurrency from measured demand. **Dependencies:** V26.
**Likely files:** proposed `verification/pi-durable/soak.ts`, proposed runner, existing trace/accounting module only if a demonstrated fix is needed, evidence manifest. **Size:** Medium.

### V27b — Coherent backup and real restore

- [ ] Stop writers and checkpoint matching Durable/Frontier state, including required SQLite/WAL state; archive inventory is complete.
- [ ] Restore into an isolated deployment and recover pending work through public APIs with the same authorized remote references; do not run a second active owner against production peers.

**Verification:** Planned V27 restore sub-lane against an independent fixture server, with retained archive and actual restore evidence. **Dependencies:** V27a, V25.
**Likely files:** proposed `verification/pi-durable/restore.ts`, proposed operations documentation, evidence manifest. **Size:** Medium.

### V27c — Retention and format transitions

- [ ] Expiry/retention never deletes unresolved work or evidence needed to reconcile it; cleanup is bounded and targets only independently verified recoverable data.
- [ ] Every supported existing→new state transition preserves logical identities and pending work; unsupported/downgrade paths fail explicitly without rewriting the prior state.

**Verification:** Planned V27 retention/upgrade sub-lane with frozen old-state fixtures and public restart observations; independent archive/restore review before material deletion. **Dependencies:** V27b.
**Likely files:** proposed `verification/pi-durable/retention.ts`, owning persistence module if needed, frozen small state fixtures, proposed operations documentation. **Size:** Medium.

## V28 — Verify a clean distributable consumer

Install the exact candidate artifact in a clean external project and complete the minimal real-agent/recovery journey through its public entry points.

**Acceptance:**
- [ ] Packed and pinned-Git installs include the durable export/runtime/type/dependency files and require no prototype-relative imports, upstream rebuild or undeclared local dependency.
- [ ] Stock Pi CLI behavior remains intact; a clean Durable consumer performs a genuine Gemini/native-code-mode Task/event recovery scenario from the installed artifact.
- [ ] Artifact scan excludes secrets/test keys/raw evidence and docs accurately state runtime/version/limit policy. Keep `private: true`; npm publication and production deployment remain separate authority.

**Verification:** Planned V28 lane; existing `bun run build:public`, `bun run test:public-exports`, and `node verification/github-install.mjs` with a pinned candidate target (not unqualified remote HEAD).
**Likely files:** `package.json`, `public-exports.test.mjs`, `verification/github-install.mjs`, proposed `docs/pi-durable.md`, proposed consumer fixture.
**Size:** Medium. **Dependencies:** V27.

## V29 — Independently certify the exact candidate

Run the full requirement ledger against the final commit/artifact and reproduce the decisive public journeys independently. Close the plan only on evidence.

**Acceptance:**
- [ ] The unfiltered Durable gate plus ordinary-Pi regression/conformance gates select every required test and pass with adjudicated deviations; stale historical counts never substitute for current results.
- [ ] Stock Durable + Gemini + installed Frontier completes native code mode→Task/human input→kill/recover→poll/push/webhook wake→approved Skill→sampling→real App→client reconnect, with peer effects matching public state.
- [ ] An independent reviewer reproduces decisive paths on the exact artifact; signed-off source/evidence manifests, commands, remaining limits and operator docs are committed/pushed without squashing. Different-model/harness verification is used when available and authorized, otherwise its absence is explicit.

**Verification:** Proposed unfiltered `bun run verify:durable`; existing `bun run verify:complete` expanded to include the required suites, plus independent clean-consumer reruns. Any product edit invalidates affected evidence and reruns the final exact-source gates.
**Likely files:** proposed runner, requirements/evidence manifest, `VERIFICATION.json` only with fresh provenance, `docs/github-release.md`, proposed `docs/pi-durable.md`.
**Size:** Medium, verification-focused. **Dependencies:** V28.

### Checkpoint C — Definition of done

- [ ] No required ledger row is failed, unverified, silently skipped or blocked by upstream.
- [ ] Every advertised capability works through the native Durable host with the relevant real-agent, peer, process and browser evidence—not only in normal Pi or a mocked SDK test.
- [ ] Unknown external outcomes are handled honestly, scope/platform limits are documented, and the exact accepted implementation plus reproducible evidence is committed and pushed.

## Planning-only handoff

No checkbox above is checked by writing this plan. The saved prototype evidence remains historical. Skills are unchanged; there is no claimed skill optimization. Implementation begins only after approval of the public seam/scope contract, using the V01–V06/V25 recovery chain first.
