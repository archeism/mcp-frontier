import { createServer } from "node:http";
import { expect, it } from "vitest";
import { McpServerManager } from "../server-manager.ts";
import { createProtocolSession, readEventCapability } from "../runtime-protocol.ts";
import { PollEventsClient } from "../mcp-events-advanced.ts";

const definition = { namespace: "events", requests: ["events/list"], streams: [], notifications: [] };
function dispatch(request: any) {
  const complete = (body: object) => ({ resultType: "complete", ttlMs: 0, cacheScope: "private", ...body });
  if (request.method === "server/discover") return complete({ supportedVersions: ["2026-07-28"], capabilities: { events: { listChanged: true } } });
  if (request.method === "events/list") return complete({ events: [{ name: "tick", delivery: ["poll"], inputSchema: { type: "object" }, payloadSchema: { type: "object" } }] });
  return complete({ tools: [] });
}
const source = `import readline from 'node:readline';const dispatch=(${dispatch.toString()});readline.createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);if(request.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:dispatch(request)})+'\\n')});`;

async function fixture(mode: "stdio" | "http") {
  let discoveries = 0;
  let capabilities: unknown = { events: { listChanged: true } };
  const http = mode === "http" ? createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let body = ""; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    if (request.id === undefined) { res.writeHead(202).end(); return; }
    if (request.method === "server/discover") discoveries++;
    const result = dispatch(request);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: request.id,
      result: request.method === "server/discover" ? { ...result, capabilities } : result }));
  }) : undefined;
  if (http) await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const address = http?.address();
  const server = address && typeof address !== "string"
    ? { url: `http://127.0.0.1:${address.port}/mcp`, auth: false as const }
    : { command: process.execPath, args: ["--input-type=module", "-e", source] };
  const manager = new McpServerManager(process.cwd());
  const owner = new AbortController();
  const connection = await manager.connect("capability-proof", { ...server, protocolVersion: "2026-07-28", tasks: false });
  const session = createProtocolSession(connection, owner.signal, definition);
  return { connection, session, discoveries: () => discoveries, setCapabilities(value: unknown) { capabilities = value; }, async close() {
    session.close(); owner.abort(); await manager.closeAll();
    if (http) { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); }
  } };
}

for (const mode of ["stdio", "http"] as const) {
  it(`${mode}: lazily recovers normative top-level Events using the real SDK, without an extension alias`, async () => {
    const f = await fixture(mode);
    try {
      // SDK 2.3.1 strips this genuine advertisement during negotiation.
      expect(f.connection.client.getServerCapabilities()).toEqual({});
      const before = f.discoveries();
      const read = readEventCapability;
      const [first, second] = await Promise.all([read(f.session), read(f.session)]);
      expect(first).toEqual({ listChanged: true });
      expect(second).toEqual(first);
      first!.listChanged = false;
      expect(await read(f.session)).toEqual({ listChanged: true });
      if (mode === "http") expect(f.discoveries() - before).toBe(1);
      expect(f.connection.client.getServerCapabilities()).toEqual({});
      expect(await f.session.request("events/list")).toMatchObject({ events: [{ delivery: ["poll"] }] });
      expect(await new PollEventsClient("capability-proof", f.session, () => {}).list()).toMatchObject([{ name: "tick", delivery: ["poll"] }]);
      expect(f.connection.activeProtocolOperations).toBe(0);
      f.session.close();
      await expect(read(f.session)).rejects.toThrow("ended");
    } finally { await f.close(); }
  });
}

it("validates draft capability contents, retries failed discovery, and caches genuine absence", async () => {
  const f = await fixture("http");
  try {
    f.setCapabilities({ events: { listChanged: "yes" } });
    await expect(readEventCapability(f.session)).rejects.toThrow();
    expect(f.connection.activeProtocolOperations).toBe(0);
    f.setCapabilities({ events: {} });
    expect(await readEventCapability(f.session)).toEqual({});
    const another = createProtocolSession(f.connection, f.session.signal, definition);
    try {
      f.setCapabilities({});
      expect(await readEventCapability(another)).toBeUndefined();
      const before = f.discoveries();
      expect(await readEventCapability(another)).toBeUndefined();
      expect(f.discoveries()).toBe(before);
    } finally { another.close(); }
  } finally { await f.close(); }
});

it("preserves the webhook namespace allowlist and the core discovery contract", async () => {
  const f = await fixture("http");
  const webhook = createProtocolSession(f.connection, f.session.signal, { namespace: "event_webhook",
    requests: ["events/list", "events/subscribe", "events/unsubscribe"], streams: [], notifications: ["notifications/events/list_changed"] });
  const core = createProtocolSession(f.connection, f.session.signal, { namespace: "core",
    requests: ["server/discover"], streams: [], notifications: [] });
  try {
    expect(await readEventCapability(webhook)).toEqual({ listChanged: true });
    expect(await core.request("server/discover")).toMatchObject({ capabilities: {} });
    await expect(core.request("server/discover", { unexpected: true })).rejects.toThrow("does not accept parameters");
    await expect(readEventCapability(core)).rejects.toThrow("Undeclared");
    const cancelled = new AbortController(); cancelled.abort(new Error("caller cancelled"));
    const before = f.discoveries();
    await expect(readEventCapability(f.session, cancelled.signal)).rejects.toThrow("caller cancelled");
    expect(f.discoveries()).toBe(before);
  } finally { webhook.close(); core.close(); await f.close(); }
});

it("binds restoration to the canonical configured definition and server label without exposing credentials", async () => {
  const f = await fixture("http");
  const sessions: ReturnType<typeof createProtocolSession>[] = [];
  const bind = (server: object, label = "proof") => {
    const session = createProtocolSession({ ...f.connection, definition: server } as typeof f.connection, f.session.signal, definition, label);
    sessions.push(session);
    return session.serverBinding;
  };
  try {
    const original = bind({ url: "https://example.test/mcp", auth: "bearer", headers: { Authorization: "Bearer private-test-value", "X-Account": "one" } });
    expect(original).toMatch(/^[a-f0-9]{64}$/);
    expect(bind({ headers: { "X-Account": "one", Authorization: "Bearer private-test-value" }, auth: "bearer", url: "https://example.test/mcp" })).toBe(original);
    expect(bind({ url: "https://other.test/mcp", auth: "bearer", headers: { Authorization: "Bearer private-test-value", "X-Account": "one" } })).not.toBe(original);
    expect(bind({ url: "https://example.test/mcp", auth: "bearer", headers: { Authorization: "Bearer rotated-test-value", "X-Account": "one" } })).not.toBe(original);
    expect(bind({ url: "https://example.test/mcp", auth: "bearer", headers: { Authorization: "Bearer private-test-value", "X-Account": "one" } }, "another-label")).not.toBe(original);
    expect(f.session.serverBinding).toMatch(/^[a-f0-9]{64}$/);
    expect(sessions[0]).not.toHaveProperty("definition");
    expect(sessions[0]).not.toHaveProperty("headers");
  } finally { for (const session of sessions) session.close(); await f.close(); }
});
