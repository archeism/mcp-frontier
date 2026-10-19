import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMcpConfig } from "../config.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mcp-auth-config-"));
  vi.stubEnv("PI_MCP_CONFIG_MODE", "exclusive");
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

const jwt = {
  grantType: "client_credentials", clientId: "client", privateKey: "${AUTH_TEST_PRIVATE_KEY}",
  signingAlgorithm: "ES256", expectedIssuer: "https://issuer.example",
};
const crossApp = {
  grantType: "urn:ietf:params:oauth:grant-type:jwt-bearer", clientId: "client", clientSecret: "secret",
  expectedIssuer: "https://issuer.example", crossAppAccess: {
    idpUrl: "https://idp.example", tokenEndpoint: "https://idp.example/token",
    idToken: "${AUTH_TEST_ID_TOKEN}", clientId: "idp-client", clientSecret: "idp-secret",
  },
};

it.each([jwt, crossApp])("preserves extension config through native and remote import paths", (oauth) => {
  const path = join(root, "config.json");
  writeFileSync(path, JSON.stringify({ mcpServers: { native: { url: "https://mcp.example/mcp", auth: "oauth", oauth } }, imports: ["opencode"] }));
  writeFileSync(join(root, "opencode.json"), JSON.stringify({ mcp: { remote: {
    type: "remote", url: "https://mcp.example/mcp", oauth: { ...oauth, ignoredExtension: "ignored" },
  } } }));
  const { mcpServers } = loadMcpConfig(path, root);
  expect(mcpServers.native?.oauth).toEqual(oauth);
  expect(mcpServers.remote?.oauth).toEqual(oauth);
  expect(mcpServers.remote?.auth).toBe("oauth");
});

it.each([
  { privateKey: 42 }, { signingAlgorithm: [] }, { expectedIssuer: "" },
  { grantType: "unsupported" }, { crossAppAccess: "secret" },
  { crossAppAccess: { idToken: 42 } }, { crossAppAccess: { unexpected: "secret" } },
  { privateKey: "key", crossAppAccess: {} },
  { ...jwt, expectedIssuer: undefined },
  { ...crossApp, expectedIssuer: undefined },
  { ...crossApp, crossAppAccess: { idpUrl: "https://idp.example", clientId: "idp-client" } },
  { grantType: "urn:ietf:params:oauth:grant-type:jwt-bearer" },
])("rejects malformed extension config in native and imported servers without exposing values", (oauth) => {
  const path = join(root, "config.json");
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  writeFileSync(path, JSON.stringify({ mcpServers: { native: { url: "https://mcp.example/mcp", oauth } }, imports: ["opencode"] }));
  writeFileSync(join(root, "opencode.json"), JSON.stringify({ mcp: { remote: { type: "remote", url: "https://mcp.example/mcp", oauth } } }));
  const { mcpServers } = loadMcpConfig(path, root);
  expect(mcpServers.native).toBeUndefined();
  expect(mcpServers.remote).toBeUndefined();
  expect(warning).toHaveBeenCalled();
  expect(JSON.stringify(warning.mock.calls)).not.toContain("secret");
});
