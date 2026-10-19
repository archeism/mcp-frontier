# Events client completion audit — 2026-10-17

## Verdict and scope

**Current checkpoint:** all three modes, canonical Pi installation, durable bounded SQLite acceptance, session-owned receipts, termination status signals and action-time approval are implemented. Historical F1/F2 defects are fixed; F3/F4 recovery paths are implemented and tested within the bounds below. The final missing-`NotFound.data.kind` webhook branches now have four RED→GREEN reproductions. The receiver security negative matrix is checked. This is ready for a frozen-source final gate, not a blanket compliance/completion certificate.

Normative anchor: [MCP Events design sketch, commit d5316be214be2e76e51462069c1d67e00a5a7619](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/d5316be214be2e76e51462069c1d67e00a5a7619/docs/design-sketch-proposal.md). This is an experimental draft, not a finalized base-protocol extension. Section names below refer to that immutable document. RFC-style MUST/SHOULD requirements are distinguished from ordinary SDK guidance, optional features, server obligations, and product hardening. No new rotation interval, retention duration, delivery ordering guarantee, or filesystem-interception requirement is inferred.

This document preserves the original read-only audit and its reproductions, but current dispositions below supersede historical present-tense descriptions. Follow-ups fixed webhook context classification, diagnostics projection, presentation policy and regression coverage; earlier workers fixed F1–F4, HTTP/2 preference and storage/receipt ownership. Historical hashes are explicitly not current-source evidence.

### Current dispositions and genuine remaining limits

- **Final-settlement receipt correction:** a later independent review reproduced Pi 1.3 updating memory before a failed receipt append, followed by settlement/ACK. The bridge now records version-2 receipts via public `pi.appendEntry` only after final successful non-aborted settlement and verifies complete on-file rows before persistent ACK/reconciliation. Actual Pi ENOSPC and continuation→abort REDs became GREEN; 55 focused checks/typecheck passed, including restart reconciliation and delayed-read session replacement. Legacy unconfirmed receipts do not suppress pending events; in-memory Pi consumption is explicitly volatile. Streaming receipt parsing bounds retained lines at 2 MiB. Real Gemini persistent poll/push/webhook proof passed at `../verification-evidence/live-events-modes-2026-10-16T19-09-45.061Z/result.json`, with disk transcript retained; the dedicated pre-ACK disk inspection also passed at `../verification-evidence/live-events-delivery-2026-10-16T19-09-45.934Z/result.json`. Final whole-source gates remain pending.

- **F1 fixed:** coordinator schemas validate current/pending secrets; driver preflights the complete restoration batch and closes a route if later installation fails. Canonical and driver malformed-key regressions cover this.
- **F2 fixed:** signed gap/termination controls bypass descriptor eligibility, remain authenticated and durably accepted. Removed-descriptor control and stale-event-schema regressions cover the distinction.
- **F3 fixed for implemented recovery:** push and webhook preserve typed termination reasons, rediscover event removal/schema changes, reuse identity/cursor, and stop on Forbidden without downgrade. Webhook now accepts absent `data`/`kind` using operation context. Explicit contradictory kinds remain rejected. Removal recovery is bounded, not a promise to migrate automatically to a differently named event.
- **F4 fixed for exercised outages:** poll reconnects on real HTTP failure; webhook reacquires same-bound sessions after HTTP/socket failure and keeps callbacks alive through a grant; no-expiry outage/late replacement/wrong-binding/Forbidden cases are covered. Push has bounded reconnect and heartbeat liveness. Pre-activation failures and deliberate final stream completion can still be terminal; indefinite retries are not promised.
- **Client SHOULD coverage:** HTTPS transport now prefers HTTP/2 through the owned Undici `allowH2: true` dispatcher for default/custom CA, with HTTP/1.1 fallback. Main's real TLS RED negotiated 1.1; GREEN negotiated 2.0, including concurrent Events streams (23 TLS cases; 129 transport/auth checks; independently 27 TLS/recovery checks in 7.79 seconds). This proves negotiation/compatibility, not a throughput or scale claim. Dedicated current-driver tests exercise quiet heartbeat checkpoints before cursor commit, silence timeout/reconnect, same-stream gaps/transient errors and absent activation/heartbeat/event cursors. Poll and webhook absent-response/payload cases are also explicit.
- **Application diagnostics fixed:** canonical `EventSubscription.deliveryStatus?: WebhookDeliveryStatus` exposes only validated status fields (`active`, optional `lastDeliveryAt`, category-only `lastError`, `failedSince`, `throttled`, `retryAfterMs`). A real-SDK HTTP RED→GREEN proves visibility and removal of private extension fields; malformed data fails validation rather than becoming a response oracle. Status-change bus signals remain minimal lifecycle metadata, not periodic diagnostics spam.
- **Pre-presentation policy implemented:** `EventsOptions.presentEvent(delivery, context, signal)` is an operator-owned redaction/sandbox seam. It changes only model presentation, not raw inbox/receipt identity. Real Pi/faux + HTTP evidence checks that operator-redacted PII and injected permission text never reach provider inputs, while the original immutable payload remains retained. Rejection sends nothing/ACKs nothing; replacement aborts even an uncooperative policy wait and fences late output. Without a configured policy the default remains JSON plus an untrusted-data warning, not semantic sanitization or prompt-injection immunity. Policy selection and redaction meaning remain application concerns, not invented wire rules.
- **Operational limits:** retained tombstones/pending rows consume permanent admission quota; full stores fail closed rather than deleting data. Registry keeps at most 100 total entries (including stopped) and an 8 MiB snapshot per Pi session; session history/receipt scans and total registry directories across sessions have no aggregate budget here. New inboxes share one bounded root; preserved pre-existing per-session inboxes are independently bounded, not one retroactive aggregate pool. Legacy immutable files require explicit migration and are never silently ignored/deleted.
- **Platform/acceptance:** local SQLite locking and directory fsync; macOS process restart only, not power loss. Fresh frozen-source full gates/live all-mode runs and independent review remain the main coordinator's final acceptance work. Optional asymmetric `v1a` verification remains unimplemented; the draft does not yet choose its normative discovery location, so none is invented.

## Evidence ledger

- Final Events slice checkpoint: **108 tests passed across nine focused files**, 11.10 seconds, plus `tsc --noEmit`. Includes 51 webhook lifecycle cases, 21 coordinator cases, six push lifecycle cases, 16 receiver security cases, actual Pi status/denial/redaction/rejection cases, session-generation policy cancellation, absent poll cursor and existing installer/receipt regressions. The real-SDK diagnostics visibility RED is fixed. Policy rejection retains pending raw data; actual provider-input assertions exclude redacted PII/instruction text; raw-payload duplicate comparison proves immutable raw retention. An uncooperative policy cancellation RED is fixed using the existing abortable helper. Public policy type is exported from both `mcp-events.ts` and `complete.ts`.

- Current bounded correction: four lifecycle REDs (missing `data`/`kind` on termination and unsubscribe), then **48 lifecycle tests GREEN**. Combined lifecycle/authenticated SDK webhook/coordinator/status run: **72 passed**, plus typecheck. Contradictory or malformed unsubscribe discriminators retain cleanup intent; Forbidden remains terminal.
- Current receiver additions: **16 security cases GREEN**, plus the existing five receiver regressions (**21 total**): correctly signed past/future timestamps at ±301 seconds, valid signature first/last, old/new multi-v1 ordering, each missing required header, wrong path/subscription/method/content type, raw-byte tampering, exact 256 KiB acceptance and oversized streamed rejection despite forged Content-Length. These exercise the real Request handler; TLS/network ingress is separately covered by listener tests.
- Prior bounded status/authority checkpoint: **70 focused tests GREEN** and typecheck; actual Pi/faux + HTTP event-triggered tool denial produces zero upstream `tools/call`. Final freeze measurements must come from the main coordinator's run, not these overlapping focused counts.

- Audit-time focused run: **79 passed / 0 failed, 14 files**, 5.60 seconds. Suites: `events-capabilities`, `mcp-events-advanced`, `mcp-events-coordinator`, `mcp-events-webhook`, `mcp-events-webhook-client`, `mcp-events-webhook-lifecycle`, `mcp-events-push-acceptance`, `mcp-events-registry`, `mcp-events-inbox`, `mcp-events-installer`, `mcp-events-pi-delivery`, `mcp-events-listener`, `runtime-protocol-transports`, and `runtime-protocol-stdio`, all under [__tests__](__tests__). These are focused checks, not a full-repository rerun.
- [Actual Pi/Gemini all-mode result](../verification-evidence/live-events-modes-2026-10-16T16-29-24.189Z/result.json): Pi 1.3.0, `gemini-3.8-flash`, passed; HTTP poll 9,058 ms, HTTP/SSE push 5,142 ms, TLS signed HTTPS webhook 5,521 ms, aggregate 19,722 ms. Recorded callbacks: verification 200 and event acceptance 202. Recorded `maxRSS` is 332608; its unit is not specified by the artifact. This proves the exercised positive workflows, not every negative/lifecycle obligation.
- Historical hash comparison: that artifact matched some files at the original audit time, not this corrected snapshot. Current source includes later rotation, recovery, status, SQLite and receipt changes. Rerun on the final frozen source; do not attribute new behavior to the older agent run.
- Earlier full JSON result [protocol-20261017-full.json](../verification-evidence/protocol-20261017-full.json) was reported as 2,691 passed / 4 failed, with the four webhook lifecycle REDs. It predates subsequent corrections. It is preserved evidence, not the final gate.
- The two probes in Findings F1/F2 below were executed in-process against actual driver/receiver classes with a minimal session double. They are independent runtime reproductions, **not checked-in regression tests or real-host integration proofs**.

Status vocabulary: **Covered** means source plus relevant executed tests; **Code-only** means implementation is visible but the named edge is not independently demonstrated here; **Gap** means absent behavior or a reproduced defect; **Optional/server** is not a missing client MUST.

## Historical findings and reproductions (retained; fixed dispositions above)

### F1 — FIXED: unvalidated restored pending signing key could leak a receiver route

Sources: [coordinator](mcp-events-coordinator.ts), `webhookState` and `restoredWebhook`; [driver](mcp-events-webhook-client.ts), `restore` and `install`; [receiver](mcp-events-webhook.ts), `register` and `updateSecrets`.

`webhookState` validates `secret` but does not declare `pendingSecret`; `.passthrough()` retains it as arbitrary data. The driver installs the route first, then conditionally calls `updateSecrets`. If this throws, `install` has not returned and the caller has not added that item to its rollback list. It also has not entered the driver's item map. Neither restoration rollback nor `suspend()` owns the orphan.

Read-only reproduction: valid original secret, UUID/path/server tuple and descriptor; `status: "stopped"`, `cleanupPending: true`, `pendingSecret: "invalid"`. `restore` rejects with the fixed invalid-key error. A correctly old-key-signed verification POST to that path nevertheless returns **200**. After `suspend()`, a GET returns **405**, not 404, proving the route remains registered. Event delivery is not proven accepted: the orphan has not acquired a remote routing ID, so this is route/verification lifecycle leakage, not evidence of forged event execution.

Additional source inference: falsy invalid values such as `""` or `0` skip `if (state.pendingSecret)` validation, while `pendingSecret ?? secret` can still select them for the outbound subscribe request. Do not describe this inference as a separately executed wire test.

Required correction/protection: explicitly validate optional `pendingSecret` with the same `whsec_`/canonical-base64/24–64-byte predicate as `secret`, rejecting invalid null/falsy/non-string values; validate the entire restoration batch before installing routes; close a newly registered route on any subsequent installation failure. Add malformed-pending-key batch/rollback regressions through the canonical coordinator and direct driver. `.passthrough()` itself need not be removed: the known security field needs a schema.

### F2 — FIXED: catalog removal blocked mandatory signed control forwarding

Source: [driver](mcp-events-webhook-client.ts), `accept`, calls `updateDescriptor` before distinguishing event/control bodies. The pinned **Non-event webhook bodies** section requires forwarding controls through the same channel as events; removal/breaking changes are specifically reasons to send termination.

Read-only reproduction: subscribe successfully; remove `tick` from the returned catalog and invoke `list_changed`; send a correctly signed, correctly routed `terminated` body with `error.code: -32023`, `data.kind: "event"`. Result: **HTTP 503**, **zero inbox accept calls**, local status remains **active**. Thus normal termination works in existing lifecycle tests, but termination concurrent with descriptor removal does not.

Correction direction: process authenticated lifecycle controls independently of event payload/input-schema eligibility; preserve signature/routing checks and durable acceptance before acknowledgement. Continue to reject obsolete event payloads. Add removal and schema-change/control race regressions. Do not use the existing removed-descriptor *cleanup* test as proof that removed-descriptor *termination delivery* works.

### F3 — FIXED within bounded recovery: schema/removal termination was not rediscovered/resubscribed

Source: [push driver](event-companion/src/stream.ts), `consume` handles every `terminated` by `finish` and retains only message text; it does not branch on the nested code/data. [Coordinator](mcp-events-coordinator.ts) records failure and restores failed entries as pending-only/terminal. Webhook termination similarly closes its route without distinguishing schema/removal from authorization revocation.

Pinned **Event Type Removal and Breaking Changes** and the error-code discussion distinguish `NotFound`/`Unsupported` (rediscover and resubscribe against the current descriptor) from `Forbidden` (stop). This is a source-backed client recovery gap, not evidence that the existing fail-closed behavior grants unauthorized access. A removed name may remain unavailable; recovery must not pretend that rediscovery guarantees a replacement descriptor. Add code/data-preserving tests and explicit policy for unavailable/new names before claiming the complete guidance is implemented.

### F4 — FIXED for exercised outages: automatic connection recovery was uneven across modes

- Push has bounded reconnect/backoff, cursor replay and configured-server-binding checks. It does not automatically retry a failure before initial activation, and treats any explicit RPC error as terminal. These are implementation limits, not invented wire requirements.
- Poll `run` turns any request failure into `failed`; the session-abort listener stops the worker. The coordinator has no poll replacement-session callback. Same-session restart restoration works, but automatic recovery from a temporary poll connection loss is not established.
- Webhook transient request renewal and restoration of a still-live grant are covered. Its driver holds one mediated session; `recover` returns immediately when that session is aborted and does not acquire a replacement. For a finite grant, the deadline still eventually closes the receiver; no-expiry behavior after session loss needs a dedicated test and recovery decision.

The draft's general Client SDK Guidance promises reconnection management. Do not equate restart restoration or the positive all-mode agent run with complete automatic outage recovery.

## Requirement map: discovery, selection, state and cursors

| Pinned requirement or requested surface | Current source and evidence | Assessment |
| --- | --- | --- |
| Discover top-level `capabilities.events`; modes are per event, none mandatory | `runtime-protocol.ts` lazy `getEventsCapabilities`; `PollEventsClient.list`; `events-capabilities.test.ts` real HTTP/stdio checks the SDK-stripped top-level advertisement without an extension alias | Covered; workaround does not rewrite SDK core capabilities |
| Runtime `events/list`, pagination, descriptors and schema validation | `mcp-events-advanced.ts` `list`, validates both schemas, rejects duplicate names/repeated cursors; advanced real-SDK pagination tests | Covered; implementation budgets: 100 pages, 256 total descriptors, 256 KiB/page |
| `list_changed` SHOULD refresh descriptors | Coordinator dirty watcher, poll dirty refresh, webhook `updateDescriptor` and periodic refresh; current input/payload validators | Covered for exercised changes; lazy rather than immediate fetch; removed-descriptor controls bypass event eligibility |
| Select configured webhook → usable push → poll; explicit override errors if unavailable | Coordinator `subscribe`; coordinator negotiation test, including rejected webhook/no silent downgrade | Covered; unavailable mode reports fixed public failure rather than the example SDK exception class |
| Reject invalid arguments before subscription | Coordinator `subscribe`/`descriptor`, all three drivers; advanced negative tests | Covered; 32 KiB argument budget is host policy, not a draft limit |
| Identity: host registry knows server, event name, arguments, delivery | Registry entries plus scoped inbox IDs; coordinator binding and restoration tests | Covered for configured-server/session identity; authenticated principal remains server/auth-layer authority |
| Client owns canonical subscription registry, not server listing | `EventsRegistry`; canonical `list`; no invented server-side listing method | Covered |
| Absent cursor MUST equal null in requests, responses and payloads | Defaults/`?? null` in all drivers/coordinator; cursor, push-lifecycle and webhook-lifecycle tests | Explicit poll response, webhook grant/occurrence/gap and push initial/repeated active/heartbeat/event cases; old replay token is cleared |
| Null cursor MUST NOT be replayed as a recovery position | Driver states store null as a sentinel and send null; no old non-null cursor is retained | Covered in source and poll tests; persisted null sentinel is not a fabricated replay token |
| Last safe cursor is reused on poll/reconnect/refresh | Poll per-page cursor, push event/active/heartbeat checkpoints, webhook delivery/refresh watermark | Covered for accepted checkpoints and exercised poll/push/webhook recovery |
| `maxAgeMs` optional replay bound in all modes | Public tool/coordinator and all driver request builders carry it; poll wire assertions and protocol/host paths | Implemented; exhaustive push/webhook clamp/truncation behavior is server-side and not proven by poll tests |
| Gap/truncated is not an error; persist fresh position and continue | Poll `truncated`, push repeated `active`, webhook `gap`; sticky registry gap indicator | Explicit same-stream push gap/transient-error recovery plus poll/webhook/removed-descriptor control tests |
| Ignore truncation when replay unsupported | Poll/push/refresh require non-null cursor before new truncation; webhook gap only sets true for non-null | Covered/code; an already-sticky prior gap can remain true after a later null cursor, so do not claim the historical indicator is current replay support |
| Deduplicate by eventId, tolerate new watermark for same occurrence | Durable inbox compares occurrence excluding cursor; driver seen sets are metrics/callback suppression only, not acceptance bypass | Covered by inbox, poll conflict and HTTP/stdio push-acceptance tests |
| Preserve occurrence/control identity and checkpoint only after acceptance | Coordinator serial acceptance, SQLite transactional inbox claim/quota, awaited driver checkpoints | Covered by asynchronous acceptance tests, conflict tests, controls and actual process contention/crash tests |
| No global ordering or exactly-once side effects | Inbox pending batches use insertion sequence per scope; webhook arrivals can reorder; Pi receipt/ack not atomic with arbitrary tool effects | Explicit limitation; poll/push retain accepted per-stream order, not cross-subscription ordering or exactly-once actions |

## Requirement map: poll and push

| Pinned requirement or guidance | Current source and evidence | Assessment |
| --- | --- | --- |
| Poll is self-contained; no subscribe/unsubscribe wire methods | `PollEventsClient.run`, local stop; advanced HTTP/stdio wire tests | Covered |
| Respect `nextPollMs` SHOULD; configurable safety floor SHOULD default to 1000 ms | `PollEventsClient` constructor floor defaults to 1000; scheduling respects hint and long timer overflow | Covered; floor is programmatic, not currently a canonical tool option |
| `hasMore` SHOULD ignore idle hint and drain backlog | `run` uses safety floor rather than `nextPollMs`; real HTTP/stdio regression with 60-second hint | Covered; not literal zero-delay draining, deliberately bounded by floor |
| `maxEvents` optional poll cap | Driver always sends 50, validates max 50 returned | Implemented fixed cap; no public per-subscription cap setter |
| Empty poll advances watermark without triggering model work | Coordinator empty acceptance checkpoint and Pi empty-poll test | Covered |
| One independent push stream per subscription; route by parent request ID | `runtime-protocol.ts` router and SDK transport; `EventConnection`; real legacy/modern transport tests and complete protocol routing tests | Covered; emitted request IDs are strings, which draft permits |
| Push SHOULD NOT use default request timeout | Mediated stream uses SDK transport framing and explicit activation/heartbeat timers, not ordinary request timeout | Code plus long-lived real stream tests; 15-second activation timeout remains intentional |
| Heartbeat liveness SHOULD reconnect after >2 intervals; checkpoint cursor during quiet periods | Push default 65 seconds; queued/awaited checkpoint; push-lifecycle tests use configured 100 ms timeout | Quiet cursor does not advance before async acceptance; silence cancels/reopens with that cursor. No negotiated heartbeat interval is invented |
| Stream failure reopens same logical subscription with last cursor | Push `interrupted`, `availableSession`, coordinator reconnect callback compares server binding | Bounded five retries/backoff, timeout/reconnect and schema-termination tests; deliberate final result remains terminal |
| Recoverable `notifications/events/error` leaves stream open | Push `consume`; dedicated push-lifecycle regression | Error leaves stream active; following event resumes on same stream and clears transient error |
| `terminated` nested error ends subscription; SHOULD remove and notify application | Push removes active stream; coordinator `onStatus` follows committed transitions; installer emits read-only status event | Real HTTP Forbidden proof; schema/removal recovery is separately tested. Terminal registry entries remain for audit/pending delivery, not active workers |
| stdio cancellation sends `notifications/cancelled`; HTTP aborts request stream | Mediated `cancelWire`/request signal, real protocol transport cancellation tests | Covered; does not wait for optional stdio final result |
| Clients MUST NOT depend on stdio final `StreamEventsResult` | Local cancel settles stream and cancels independently of a result | Covered in source/transport tests |
| Remove only the selected stream; cancellation releases pins/resources | Independent-stream protocol tests; coordinator owns one driver/session per logical subscription | Covered for tested paths |
| Concurrent streams MAY; HTTP/2 SHOULD be preferred at scale | Official SDK with owned HTTPS Undici `allowH2: true` dispatcher (default/custom CA), HTTP/1.1 fallback | Real TLS 1.1 RED→2.0 GREEN and concurrent Events streams covered by main's transport lane; no throughput/capacity claim |

## Requirement map: webhook lifecycle and security

| Pinned requirement or requested surface | Current source and evidence | Assessment |
| --- | --- | --- |
| Authenticated principal MUST identify webhook subscribe/unsubscribe | Both calls use the mediated SDK/session; authenticated HTTP fixture rejects missing bearer auth | Server obligation exercised positively; no client-supplied principal or routing-ID authority; arbitrary server compliance is not certified |
| Immutable key `(principal, URL, name, canonical-JSON arguments)`; ID is response-only | Driver reuses stored name/arguments/URL, requires stable returned ID, unsubscribe sends tuple not ID; rotation wire assertions | Covered; canonical argument equality is server-side, while coordinator uses `stableStringify` for restored equality |
| Generate REQUIRED `whsec_` + base64 24–64 random bytes; SHOULD use CSPRNG | `randomBytes(32)`; receiver and restored current/pending-key validation; generated rotation | Covered including malformed/falsy restored key batch preflight and installation rollback |
| Persist/register secret before first callback; pending subscription SHOULD respond retryably | Driver save → register → subscribe; receiver returns 425 before ID activation | Covered by authenticated challenge fixture and receiver tests |
| TLS callback URL MUST use HTTPS | Driver callback-base validation; real TLS listener test with explicit trusted CA rejects untrusted certificate | Covered; operator must provide routable infrastructure, no public deployment promise |
| Endpoint verification MUST precede delivery | Receiver authenticates and echoes verification; real SDK fixture and live HTTPS/Gemini callbacks | Receiver side covered; nonce uniqueness/lifetime/constant-time echo comparison and per-principal URL verification caching are server duties |
| Refresh MUST precede finite `refreshBefore`; authoritative grant, server clamp allowed | Driver `refresh`, 80% scheduling, deadline abort, retry/backoff; lifecycle tests | Covered for finite renewal/retry/hung request. No rejecting longer-than-suggestion grants; no fixed client TTL ceiling imposed |
| No-expiry grant only when client requests `ttlMs: null`; SHOULD occasionally refresh and list | Driver rejects unsolicited null; hourly 80%-scheduled health renewal and dirty catalog fetch | Explicit opt-in/finite-grant acceptance and no-expiry periodic catalog+refresh tests; no public in-place TTL setter is claimed |
| Quiet-period refresh watermark and deliveryStatus diagnostics | Driver persists refresh cursor; shared validated typed diagnostics projected through canonical `list()` | Refresh cursor and public throttling/category/extension-stripping tests; private driver state never exposed |
| Rotation supplies new secret on same-key refresh; server SHOULD dual-sign briefly | `rotateSecret`, pending write-ahead key, bounded receiver key set, same tuple/ID; canonical action and coordinator test | Covered driver/coordinator; no automatic interval or client timer-grace invented; agent-run public rotation remains unverified |
| Rotation uncertainty survives restart; secrets stay private | Pending key persisted/reused; lifecycle restore test; public state omits both secrets; fixed tool errors | Valid rotation plus malformed restored current/pending-key cases covered; F1 fixed |
| Multi-signature header accepts any valid `v1` signature | Official verifier and current/pending verifiers | Valid-first/last and old/new signature-order receiver cases; server dual-sign grace is not client-generated |
| MUST verify raw-body HMAC before processing; freshness SHOULD reject >5 minutes | Streamed bytes, canonical timestamp, fatal UTF-8, official verifier | Raw tamper/UTF-8/noncanonical timestamp plus correctly signed ±301-second receiver rejections |
| Required headers, POST, JSON, subscription routing, bounded body | Required headers, route-ID check, POST/JSON, 256 KiB actual-byte cap | Each missing header and wrong path/ID/method/type rejected; exact cap accepted, oversized streamed body rejected despite forged length |
| Endpoint MUST forward gap/terminated controls; signed verification echoes nonce | Controls distinguished before descriptor-dependent validation; driver/inbox tests | Gap/termination accepted despite descriptor removal; stale ordinary payload still rejected; F2 fixed |
| Acknowledgement SHOULD follow durable accept/forward | Receiver awaits transactional SQLite acceptance and directory sync | Deferred acceptance, real competing processes and before/after-COMMIT SIGKILL; macOS process restart, not power loss |
| Eager unsubscribe uses original tuple; no-expiry stop needs explicit cleanup | Driver writes stopped/cleanupPending before close/cancel/request; treats explicit missing-subscription as completed; restores cleanup despite descriptor removal | Covered; authorization failures retain cleanup intent; remote server applying an already-cancelled subscribe late remains a distributed cancellation limitation, not proof of exactly-once cleanup |
| SSRF, rebinding, redirects, verification rate limits, delivery retries, 410/413 handling | Implemented by remote webhook sender, not this receiver | Server obligations; fixtures do not certify arbitrary servers. Receiver produces 413 for oversize; no public configurable 410 rejection hook |
| Optional asymmetric `v1a` server identity | HMAC-only receiver ignores unsupported signature versions via library | Optional, not implemented. Pinned draft defers the normative discovery location; do not invent card/JWKS semantics |

## Registry, host policy, recovery and operational limits

| Surface | Source/evidence | Assessment |
| --- | --- | --- |
| Correct Pi session, endpoint/configured-server restoration | `runtime-protocol.ts` binding hashes canonical configured definition + label; coordinator preflights batch; registry session ID; binding tests | Covered; configured binding is explicitly **not proof of OAuth subject continuity** when credentials resolve dynamically |
| Fork/session replacement cannot consume another session's inbox | `mcp-events.ts` session-hashed storage, synchronous detach, generation-bound notifications; installer tests | Covered for tested replacement; no general authorization inheritance or arbitrary fork import promised |
| One active consumer; process restart recovery | SQLite exclusive lease; registry atomic private rename; killed-process tests | Local SQLite locking, atomic rename and directory fsync; no atomic-hardlink runtime requirement for current inbox |
| Crash-safe accepted events and dedup tombstones | Inbox competing-process/SIGKILL tests and cursor-independent retry identity | Covered for process death, not whole-machine power loss; no exactly-once external side effects |
| Event receipt grants no action authority; clients SHOULD support receipt/action policy | Pi receives explicitly untrusted data; subsequent MCP tool calls retain existing authorization/approval paths; `mcp-events-status.test.ts` real Pi + HTTP test | Controlled model sees an event claiming permission and attempts the approval-gated MCP tool; UI declines, server receives zero `tools/call` requests. Existing policy composition, not an Events-specific policy engine or prompt-injection immunity claim |
| Clients SHOULD sanitize/sandbox event payloads before LLM presentation | Operator-owned `EventsOptions.presentEvent`, exported `EventPresentationPolicy`; JSON warning default; separate authorization | Actual Pi provider receives operator-redacted content only; raw immutable inbox preserved. Throw/abort sends nothing and ACKs nothing. Operator must configure meaningful policy; no default semantic sanitizer or injection-immunity claim |
| Acknowledgement only after actual agent consumption | Final successful non-aborted `agent_settled` records version-2 receipt through public `pi.appendEntry`; persistent file rows are verified before ACK/reconciliation | Actual Pi ENOSPC, continuation abort, restart and generation-fence regressions; persistent real Gemini workflows. Queueing or a memory-only failed append is not persistent consumption proof; explicit in-memory sessions are volatile |
| Private public interface and errors | Tool hides callback/keys/driverState; fixed public failure; real HTTP credential-oracle regression | Covered for tested failures; event payloads remain deliberately untrusted server data, not sanitized trusted instructions |
| Capacity and retention | Registry 100 retained entries / 8 MiB per session; shared-root SQLite inbox; bounded push acceptance and Pi messages | Inbox defaults: 10,000 retained rows/32 MiB JSON/512 KiB record/256 MiB DB+journal budget, pending 100 rows/1 MiB. Atomic cross-process admission; duplicates and ACK at capacity; no GC. Legacy session directories retain separate caps; registry/history aggregation limits remain explicit |
| Complete final acceptance | Positive agent transport run + focused checks | Still requires frozen-source full suite and all-mode agent rerun, negative requirements above, and independent review of that same source |

## Snapshot anchors

### Bounded follow-up evidence: application status and action authority

`__tests__/mcp-events-status.test.ts` adds a real-SDK HTTP Forbidden push
termination regression: durable status already became `failed` while no
application observer was notified (RED). Coordinator `onStatus` and the
installer event-bus signal make that observer check GREEN after registry save.
Only actual status transitions are emitted; repeated active cursor checkpoints
do not emit another status. The signal is frozen, session-scoped and contains
only version/session ID/subscription ID/server/name/delivery/status. No private
driver state, arguments, payload, cursor or upstream error text is included.
Observers cannot grant actions; observer exceptions do not alter delivery.

Two actual Pi/faux + real HTTP cases verify zero model calls for status-only
signals and that a received event cannot bypass tool approval: the controlled
model attempts `danger`, the operator UI selects `Deny`, and the upstream
`tools/call` count stays zero. This is an authority-boundary proof, not evidence
that every model will ignore hostile event text. It does not replace frozen-source
full-suite, all-mode live-model verification or independent review.

SHA-256 values read during this audit (before any requested production corrections):

```text
mcp-events.ts                    eed4436ba97388db398b9635661c728ef198f6278a9b3c4c2fbebb349e83c417
mcp-events-coordinator.ts        9a9be49fead2b553870b69f6d0ddb36048ccf8788285e2bd0f8698ee5de729b2
mcp-events-webhook-client.ts     d5c0e3cb6ae47552efab6156b1e6882fc41b02c986703fdbe59ac0bc4809e5ac
mcp-events-webhook.ts            5776f95f74670893989c8db80fc40e717005436cbb04e481a4b3510fa93d1d56
mcp-events-advanced.ts           76a741aa470a9cfb2d5d11235de9ddb8c66ee88bf6c7c6be539b66bb6651dc29
event-companion/src/stream.ts    8555881691fb0f43aaa00588276dbc09f4cd5e69d2b6a0b98f8c182a4a13fe03
runtime-protocol.ts              5b624df06eecd8bfa73479722a91ff66eb259ff40d05a61794277a108edcc947
mcp-events-registry.ts           cdb6f3b715d99da5ece3cff9ee87d8dd7a7bd17802419338970b1bd08f7a483c
mcp-events-inbox.ts              d4d45b79da809b2ef08cd3025f4076d9714420b552507bd7a8e1f80606918e91
mcp-events-pi-delivery.ts        62bb816daed220bb4771e4baaf88a944285ec57de3e0b4c6e367caec4019d17f
```

## Acceptance continuation

1. F1–F4 and contextual optional-kind correction now have fixed dispositions above; preserve all RED/failed artifacts rather than treating their old hashes as current source.
2. Preserve the explicit receiver security matrix, diagnostics projection, push lifecycle/absent-cursor coverage and actual Pi denied-action/redaction proofs in final checks.
3. HTTP/2 preference is covered by main's completed transport lane; main owns final frozen-source verification. This slice does not certify arbitrary remote sender auth/SSRF/TTL behavior or optional asymmetric discovery.
4. Freeze/hash current source, rerun full checks and actual Pi/Gemini all-mode workflows including public rotation, and independently review that exact source. Process-restart durability, bounded recovery and operator-selected presentation policy remain explicit contracts, not exactly-once or universal prompt-injection guarantees.
