# Provenance

This is a local integration fork, not an upstream release or an official MCP SDK project.

| Component | Frozen source | License |
| --- | --- | --- |
| Core adapter | [nicobailon/pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter/tree/574bee1f4fc5d2676b32a95f97a58f2402c01633), release 5.3.1 | MIT, root `LICENSE` |
| Events companion | [mikekelly/pi-mcp-events](https://github.com/mikekelly/pi-mcp-events/tree/45f3ac07da065dfdcdf7e8dc0f2b4012c56cd168), release 0.2.0 | MIT, `event-companion/LICENSE` |
| Protocol SDK | Official `@modelcontextprotocol/client` and `core` 2.3.1 | Dependency licenses |
| Tasks | Official `@modelcontextprotocol/ext-tasks` 0.2.2; exact installed package in `bun.lock` | Dependency license |
| Target host | `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui` 1.3.0 | Dependency licenses |

Original adapter files, documentation, attribution and tests are retained. Integration changes include the combined entry point, complete core protocol tool, final Skills extension, roots, broader sampling, Tasks lifecycle, authentication providers and security/regression tests. Vendored Events changes are limited to strict TypeScript compatibility. The old adapter event-bus identifiers remain intentionally stable.

No proprietary implementation was copied. Dependency versions are checkpointed in `bun.lock`. The visualizer example has a separate dependency graph and is not the production client's protocol SDK.
