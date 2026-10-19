# Native Pi codemode-only integration

Use the stock Pi **1.3.0** `codemode` extension with this complete MCP extension. The model sees one top-level tool, `codemode`; MCP tools remain callable through Pi's normal nested-tool pipeline. No Pi rebuild, replacement scripting engine or `mcpScript` is needed.

## CLI setup

Merge these values into Pi's user or trusted project `settings.json`, preserving other settings:

```json
{
  "defaultTools": ["+codemode"],
  "codemode": { "mode": "only" }
}
```

Keep your existing `mcpServers` in `mcp-adapter.json`. Merge these adapter settings for native deferred discovery and to leave the separate MCP-only scripting tool off:

```json
{
  "settings": {
    "directTools": "search",
    "scriptMode": false
  }
}
```

Load the complete extension once, with built-in MCP disabled:

```sh
pi --no-mcp -e /absolute/path/to/pi-mcp-complete/complete.ts
```

Use Pi 1.3, not an older global executable. `codemode.mode: "only"` changes model presentation, not authorization: do not remove the underlying tools with an allowlist or mark them hidden. The script can discover them with `searchTools()`, `describeTool()` and `ALL_TOOLS`, then call `tools.<registered_name>(args)`. Advanced control tools include `tools.mcp_events`, `tools.mcp_skills` and `tools.mcp_protocol`.

Modern MCP discovery requires server `protocolVersion: "auto"` or `"2026-07-28"`. An omitted version retains legacy behavior. Sampling, elicitation and remote Skills still require their normal configured permissions and consent; codemode grants no extra authority.

## Embedding

SDK hosts supply `createCodemodeExtension({ mode: "only" })` and `createCompleteMcpClient(options)` as `DefaultResourceLoader.extensionFactories`, set `defaultTools: ["+codemode"]`, load resources and bind extensions. Disable the built-in MCP factory. Preserve the actual session and nested tool execution; do not evaluate model scripts with `eval()` or dispatch directly to an MCP transport.

The host must provide an interaction interface for approvals and Apps. A headless host without one denies interactive operations; it must not silently approve them. Apps require an actual supported browser/UI bridge, not merely forwarding HTML or a script's selected output.

## Protocol boundaries

- Tasks, sampling and elicitation execute inside the normal nested MCP call, retaining approval, cancellation and recovery behavior.
- Skills tools retain manifest validation, supporting-file consent and origin policies.
- Events subscriptions are created from scripts; later delivery wakes the agent outside the script. A script is not kept running to receive events. Persistent session receipts and inbox acknowledgement retain their existing guarantees.
- Apps are hosted by the MCP executor and browser bridge. UI actions remain bound to their originating server and approval policy independently of script output.

These are integration contracts. The timestamped acceptance record identifies which complete native-codemode workflows were actually exercised; focused scripted-model tests and real Gemini/browser runs are distinct evidence.

## Reproduce

```sh
bun run test:live-codemode-tasks
bun run test:live-codemode-events-skills
bun run test:live-codemode-apps
bun run verify:complete
```

The complete verifier retains these real-agent results alongside the existing regression, OAuth, package and conformance checks. It requires successful reported outcomes, not just successful process launches. See `COMPLETE.md` for protocol pins and explicit durability/provider limits.
