# MCP Frontier: GitHub distribution

Repository: https://github.com/archeism/mcp-frontier

```sh
pi install git:github.com/archeism/mcp-frontier
```

Requires Pi 1.3 and Node 22.19 or later. Load this extension only once; do not also load the upstream adapter or the Events companion. Configuration and limitations are in [COMPLETE.md](../COMPLETE.md) and [native-codemode.md](native-codemode.md).

The package is named `mcp-frontier`. npm publication is not part of this GitHub release; `private: true` intentionally prevents accidental npm publication. Built `dist/` helpers are committed so Git installations work without an install-time TypeScript build.

## Verification provenance

[VERIFICATION.json](../VERIFICATION.json) is the immutable pre-distribution checkpoint under the previous working name, `pi-mcp-complete`. Its source hash and pending-publication field describe that checkpoint, not the renamed GitHub tree. It records 2,898 Vitest/browser tests, 179 OAuth tests, seven public/package/host tests, 25 conformance checks and seven real Pi/Gemini workflows. One macOS platform skip and one declared OAuth conformance exception remain.

The distribution changes rename package identity and public-package test fixtures, add repository/install documentation, track generated public helpers, and switch inherited CI dependency installation to the existing Bun lockfile. Production protocol implementations are unchanged. The public-package/actual-Pi-loader checks are rerun for the renamed package.

See [acceptance and limits](NATIVE-CODEMODE-ACCEPTANCE.md), [independent review adjudication](REVIEW-ADJUDICATION.md), and [upstream attribution](../THIRD_PARTY.md). Historic raw evidence and archives referenced by the checkpoint remain in the originating workspace, not in this repository; the committed summaries are not a claim that those local paths are publicly downloadable.

Operating skills were used unchanged; no skill-improvement claim is made.

## GitHub installation verification

`node verification/github-install.mjs` installed the public GitHub source with stock Pi 1.3 into an isolated temporary agent directory, then used Pi's actual resource loader to register `mcp_events` and `mcp_skills` with no extension errors. Operator settings were not changed. Renamed public-package checks passed seven tests with one platform skip; package manifest checks passed all twelve tests.

GitHub Actions is not enabled: the publishing OAuth login lacks `workflow` scope. The inherited CI recipe is preserved as `ci-workflow.reference.yml` in this directory, using the committed Bun lockfile. This release does not claim a green GitHub CI run.

After renaming the remaining OAuth self-import, both strict typechecks passed and all 179 OAuth tests passed. Independent read-only distribution review found no concrete install blocker. The first remote-install proof used commit `c608722`; the follow-up adds the reusable verifier, these results, and the test-import/documentation corrections, without changing production runtime code.
