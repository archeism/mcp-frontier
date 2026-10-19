import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generateKeyPair, exportPKCS8, jwtVerify } from "jose"
import { auth, AuthorizationServerMismatchError } from "@modelcontextprotocol/client"

process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "memory"
const directory = mkdtempSync(join(tmpdir(), "mcp-auth-extensions-"))
process.env.MCP_OAUTH_DIR = directory
const { McpOAuthProvider } = await import("./mcp-oauth-provider.ts")
const { createOAuthFetch } = await import("./mcp-auth-fetch.ts")
const { extractOAuthConfig, startAuth, createOAuthRuntime, shutdownOAuth } = await import("./mcp-auth-flow.ts")
const issuer = "https://issuer.example"
const resource = "https://mcp.example/mcp"

test("SDK private-key JWT signs the assertion and pins credentials to the issuer", async t => {
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const keys = await generateKeyPair("ES256", { extractable: true })
  const config = extractOAuthConfig({ url: resource, oauth: {
    grantType: "client_credentials", clientId: "client", expectedIssuer: issuer,
    signingAlgorithm: "ES256", privateKey: await exportPKCS8(keys.privateKey),
  } })
  const provider = new McpOAuthProvider("jwt-extension", resource, config, { onRedirect: () => assert.fail("unexpected redirect") })
  let tokenRequests = 0
  const fetchFn = createOAuthFetch(resource, undefined, undefined, { delegate: async (input, init) => {
    const url = String(input)
    if (url.includes("oauth-protected-resource")) return Response.json({ resource, authorization_servers: [issuer] })
    if (url.includes("oauth-authorization-server")) return Response.json({
      issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, response_types_supported: ["code"],
      token_endpoint_auth_methods_supported: ["private_key_jwt"], grant_types_supported: ["client_credentials"],
    })
    assert.equal(url, `${issuer}/token`)
    tokenRequests++
    const body = new URLSearchParams(String(init?.body))
    assert.equal(body.get("grant_type"), "client_credentials")
    assert.equal(body.get("resource"), resource)
    const { payload } = await jwtVerify(body.get("client_assertion")!, keys.publicKey, { issuer: "client", audience: issuer })
    assert.equal(payload.sub, "client")
    return Response.json({ access_token: "test-token", token_type: "Bearer" })
  } })
  provider.setAuthFetch(fetchFn)
  assert.equal(await auth(provider, { serverUrl: resource, fetchFn }), "AUTHORIZED")
  assert.equal(tokenRequests, 1)
  assert.equal((await provider.tokens())?.access_token, "test-token")
  await provider.saveDiscoveryState({ authorizationServerUrl: "https://other.example", resourceMetadata: { resource } })
  await assert.rejects(provider.clientInformation(), /issuer changed/)
  const fresh = new McpOAuthProvider("jwt-pinned", resource, config, { onRedirect: () => {} })
  await fresh.saveDiscoveryState({ authorizationServerUrl: "https://other.example", resourceMetadata: { resource } })
  await assert.rejects(fresh.clientInformation(), AuthorizationServerMismatchError)
  assert.equal(tokenRequests, 1)
})

test("extension configuration fails closed before signing without an expected issuer", () => {
  assert.throws(() => new McpOAuthProvider("unpinned", resource, {
    grantType: "client_credentials", clientId: "client", signingAlgorithm: "ES256", privateKey: "key",
  }, { onRedirect: () => {} }), /expectedIssuer/)
  assert.throws(() => new McpOAuthProvider("missing-idp", resource, {
    grantType: "urn:ietf:params:oauth:grant-type:jwt-bearer",
  }, { onRedirect: () => {} }), /crossAppAccess/)
})

test("user-gated step-up preserves the challenge scope together with configured scope", async () => {
  const originalFetch = globalThis.fetch
  const runtime = createOAuthRuntime()
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input)
    if (init?.method === "POST" && url === resource) return new Response(null, { status: 401 })
    if (url.includes("oauth-protected-resource")) return Response.json({ resource, authorization_servers: [issuer], scopes_supported: ["basic"] })
    if (url.includes("oauth-authorization-server")) return Response.json({
      issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
      response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
    })
    assert.fail(`unexpected request: ${url}`)
  }, originalFetch)
  try {
    const { authorizationUrl } = await startAuth("step-up-options", resource, { url: resource, oauth: {
      clientId: "client", scope: "basic", redirectUri: "https://client.example/callback",
    } }, { runtime, scope: "write", forceReauthorization: true })
    assert.deepEqual(new Set(new URL(authorizationUrl).searchParams.get("scope")?.split(" ")), new Set(["basic", "write"]))
    assert.equal(new URL(authorizationUrl).searchParams.get("resource"), resource)
  } finally {
    globalThis.fetch = originalFetch
    await shutdownOAuth(runtime)
  }
})
