# Native codemode-only integration acceptance

Frozen whole-source SHA-256: `cb02fc440c9c3f8d38fe99127d0c6d5b0aed8109b33f072a2d01b4ef326e7f16`.
This record requires the matching successful final manifest and independent-review adjudication; its creation is not acceptance of an unfinished gate.

## Contract

Stock Pi 1.3.0 exposes only native `codemode` to the outer model. Our MCP tools remain callable through Pi's actual nested execution pipeline. `mcpScript` is disabled. No Pi rebuild, second code engine, Durable port or service/frontend implementation is part of this change.

| Boundary | Required observed outcome |
| --- | --- |
| Model/tool presentation | Actual outer provider requests declare exactly `codemode`; successful scripts invoke registered underlying MCP tools |
| Tasks | Modern and legacy task-backed sampling/elicitation finish; nested IDs reach original wire metadata; consent remains required; abort targets the task; known legacy work resumes after HTTP session expiry without a second original invocation |
| Skills | Metadata discovery does not activate; activation/file consent, integrity and origin denial remain enforced through nested calls |
| Events | Poll, push and signed webhook delivery wake an idle agent; codemode consumes data revealed only by that event; disk receipts precede ACK; restart reconciles a held ACK without duplicate event presentation or automatic model execution |
| Apps | A nested MCP call opens the production bridge; real Chrome and the official App SDK initialize and receive the tool result; browser/Pi denial, original-server binding and tokenless rejection prevent forbidden execution |
| Native distribution format | Pi's actual package installer registers the extracted package in an isolated agent directory, and normal resource discovery loads its complete extension without changing operator settings |

## Implementation and Personal skills

All 101 production root TypeScript modules match the previous accepted source checkpoint `5c4c99840117122aa5e8ba0d15b60f5b8af4ac43719635f754310e3a3cf35e2d`. Existing native interfaces already support the integration. Changes add the documented profile, real-host and real-provider/browser proofs, strict typechecking, package installation checks and full-gate wiring—not an unnecessary new public API or runtime fork.

Personal Addy API/interface-design and test-driven-development skills were loaded directly from `~/personal/plugins/addy/skills/`, upstream revision `dc27a9c2e13721158157632de61b4106c6c2a2a1`. The API skill's existing-interface/contract/boundary principles guided the choice to reuse stock codemode and preserve the existing MCP execution path. Skills remain unchanged. Already-green runtime characterizations are not called RED→GREEN product fixes.

## Review-driven proof corrections

- The earlier live Apps proof verified actual calls but recorded declarations only for its faux provider. A nonempty live-declaration assertion failed, then capture at the actual `runtime.streamSimple` boundary produced three real request tool lists, each exactly `["codemode"]`. Existing browser/security assertions stayed intact.
- The earlier Events proof supplied the known arithmetic answer in its prompt and checked no-replay only over 250 ms. It remains retained as limited evidence. The strengthened proof introduces unpredictable per-delivery nonce/operands absent from prior context, checks the codemode result, awaits actual ACK reconciliation and guards against duplicate messages/automatic turns/provider requests through the later Skills workflow.
- The native package-install check initially assumed Pi stores absolute sources. Source inspection showed Pi intentionally stores paths relative to the agent directory; the test oracle was corrected. No production installation bug is claimed.
- The existing README-link test initially recognized only upstream URLs; it now validates this fork's relative documentation links as well. Missing files/anchors still fail.

## Qualifications

Real Gemini verifies integration happy paths. Deterministic actual-Pi tests cover Task denial/cancellation and related failure boundaries; they are not described as live-Gemini adversarial trials. Existing cross-task/correlation regressions remain separate protection. Apps credential absence is checked in model output and app state, not asserted for every possible browser/network surface. Browser proof uses a local supported host, not an unimplemented mobile renderer.

Single successful workflows do not establish a general model-quality, throughput, flake-rate or production-load claim. Live records retain usage, elapsed time and parent-process maximum RSS; these are not whole-process-tree capacity measurements. Existing protocol pins, finite retained-storage quotas, explicit in-memory volatility, provider limitations and no exactly-once/power-loss guarantee remain in force. One strict-issuer conformance exception and the macOS Linux-keyring platform skip remain visible.

## Publication state

The package is locally installable and checkpointable. No Git remote or published package identity was supplied. A nonblocking destination question is outstanding; source/package publication is not claimed until a destination is resolved and the remote installation path is verified. GitHub account access and organization membership were checked read-only; they do not by themselves choose a publication target.

## Frozen gate and restore evidence

The complete runner exited 0 in 410.669 seconds. It recorded 2,898 Vitest/browser passes, zero failed/pending cases, both strict typechecks and build passing, 179 OAuth passes, seven packaged-export/native-install/actual-Pi-host passes plus one declared Linux-keyring platform skip, and 25 conformance passes plus the declared strict-issuer exception.

All seven live workflows passed on this unchanged source, including the three native-codemode proofs:

- Tasks: `../live-codemode-tasks-2026-10-19T13-26-14.536Z/result.json`, modern and legacy real Gemini.
- Events/Skills: `../live-codemode-events-skills-2026-10-19T13-26-32.035Z/result.json`, 72.263 seconds, all three modes with unpredictable event-derived outputs and guarded restart reconciliation.
- Apps: `../live-codemode-apps-2026-10-19T13-27-45.160Z/result.json`, 10.081 seconds, real Gemini and Chrome.

Both archive hashes were verified. Extracting the complete source into an isolated temporary directory produced exactly the frozen whole-source hash and matched the live workspace.

- Package: 2,092,453 bytes; SHA-256 `d9cf8a55fb2fbd98d1f5f8e71fc12273a28efcb055e511bcd1c928c3114cbb5e`.
- Complete source: 5,512,464 bytes; SHA-256 `931a7246c3362a1b72ddbe84622261ec9e310cafee45af4e598bd1a884469b52`.

The known managed Gemini credential was checked in-memory against 452 source files and was absent; its value was never printed or included in the record. This is a specific leak check, not a universal secret-audit certification.

Final review is adjudicated in `REVIEW-ADJUDICATION.md`; no native-codemode integration blocker remains. One conditional reflection behavior is explicit: Skills/core forward server-supplied error content, so a server can reflect credentials it already received. Independent private-host-secret disclosure was not reproduced; universal server-content redaction is not promised. Publication remains a separate unresolved destination choice.
