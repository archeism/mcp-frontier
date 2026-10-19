import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { McpServerManager } from "../server-manager.ts";
import { createProtocolSession } from "../runtime-protocol.ts";
import { PollEventsClient, POLL_EVENTS_PROTOCOL } from "../mcp-events-advanced.ts";
import { DurableWebhookInbox } from "../mcp-events-inbox.ts";

function makeDispatch() {
  const log: Array<{ method: string; params: any; at: number }> = [];
  const inputSchema = { type: "object", properties: { mode: { enum: ["valid", "invalid", "loop", "pending", "gap", "conflict-page", "conflict-retry"] } }, required: ["mode"], additionalProperties: false };
  const payloadSchema = { type: "object", properties: { value: { type: "integer" } }, required: ["value"] };
  return (request: any, send: (frame: unknown) => void) => {
    log.push({ method: request.method, params: request.params, at: Date.now() });
    const reply = (result: any) => send({ jsonrpc: "2.0", id: request.id, result });
    const complete = (value: any) => ({ resultType: "complete", ttlMs: 0, cacheScope: "private", ...value });
    if (request.method === "server/discover") return reply(complete({ supportedVersions: ["2026-07-28"], capabilities: { tools: {}, events: {} } }));
    if (request.method === "tools/list") return reply(complete({ tools: [{ name: "inspect", inputSchema: { type: "object" } }] }));
    if (request.method === "tools/call") return reply(complete({ content: [{ type: "text", text: JSON.stringify(log) }] }));
    if (request.method === "events/list") return reply(complete({ events: request.params?.cursor
      ? [{ name: "tick", delivery: ["poll"], inputSchema, payloadSchema }]
      : [{ name: "push-only", delivery: ["push"], inputSchema, payloadSchema }],
      ...(request.params?.cursor ? {} : { nextCursor: "page-2" }) }));
    if (request.method === "events/poll") {
      const { cursor, arguments: args } = request.params;
      if (!cursor) return reply(complete({ events: [], cursor: args.mode === "gap" ? null : "0", truncated: args.mode === "gap", nextPollMs: 30 }));
      if (args.mode === "pending") return;
      if (args.mode === "conflict-page" || args.mode === "conflict-retry") {
        const event = { eventId: "e1", name: "tick", timestamp: "2026-10-16T14:00:00Z", data: { value: cursor === "0" ? 1 : 2 } };
        return reply(complete({ events: args.mode === "conflict-page" && cursor === "0" ? [event, { ...event, data: { value: 2 } }] : [event],
          cursor: cursor === "0" ? "1" : "2", hasMore: cursor === "0", nextPollMs: 60000 }));
      }
      const event = { eventId: cursor === "0" ? "e1" : "e2", name: "tick", timestamp: new Date().toISOString(), data: { value: args.mode === "invalid" ? "wrong" : 1 } };
      return reply(complete({ events: cursor === "0" ? [event, event] : cursor === "1" ? [event] : [],
        cursor: args.mode === "loop" ? cursor : cursor === "0" ? "1" : "2", hasMore: cursor === "0", nextPollMs: cursor === "0" ? 60000 : 5000 }));
    }
    if (request.id !== undefined) send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown method" } });
  };
}
const stdioSource = `import readline from 'node:readline'; const dispatch=(${makeDispatch.toString()})(); readline.createInterface({input:process.stdin}).on('line',line=>dispatch(JSON.parse(line),frame=>process.stdout.write(JSON.stringify(frame)+'\\n')));`;

async function fixture(mode: "stdio" | "http", accept?: (body: any) => Promise<void>) {
  const manager = new McpServerManager(process.cwd());
  const owner = new AbortController();
  const dispatch = makeDispatch();
  const http = mode === "http" ? createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let body = ""; for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    if (message.id === undefined) { dispatch(message, () => {}); res.writeHead(202).end(); return; }
    dispatch(message, frame => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(frame)));
  }) : undefined;
  if (http) await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const address = http?.address();
  const definition = address && typeof address !== "string"
    ? { url: `http://127.0.0.1:${address.port}/mcp`, auth: false as const }
    : { command: process.execPath, args: ["--input-type=module", "-e", stdioSource] };
  const connection = await manager.connect("poll", { ...definition, protocolVersion: "2026-07-28", tasks: false });
  const session = createProtocolSession(connection, owner.signal, POLL_EVENTS_PROTOCOL);
  const deliveries: any[] = [];
  const client = new PollEventsClient("poll", session, async value => { if (accept) await accept(value); deliveries.push(value); }, 5);
  const inspect = async () => {
    const result = await connection.client.callTool({ name: "inspect", arguments: {} });
    const first = result.content[0];
    if (first?.type !== "text") throw new Error("Missing wire log");
    return JSON.parse(first.text) as Array<{ method: string; params: any; at: number }>;
  };
  return { manager, connection, client, session, deliveries, inspect, async close() {
    client.close(); owner.abort(); await manager.closeAll();
    if (http) { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); }
  } };
}

for (const mode of ["stdio", "http"] as const) {
  for (const scenario of ["conflict-page", "conflict-retry"] as const) {
    it(`${mode}: durable acceptance rejects ${scenario} without advancing the conflicting page cursor`, async () => {
      const root = await mkdtemp(join(tmpdir(), "poll-conflict-"));
      const inbox = new DurableWebhookInbox(root);
      const attempted: number[] = [];
      const f = await fixture(mode, async body => {
        for (const event of body.events ?? []) { attempted.push(event.data.value); await inbox.accept("poll-proof", event.eventId, event); }
      });
      try {
        const sub = await f.client.subscribe("tick", { mode: scenario });
        await expect.poll(() => f.client.status(sub.id)[0]?.status).toBe("failed");
        expect(attempted).toEqual([1, 2]);
        expect(f.client.status(sub.id)[0]).toMatchObject({ cursor: scenario === "conflict-page" ? "0" : "1",
          delivered: scenario === "conflict-page" ? 0 : 1, duplicates: 0, error: expect.stringContaining("different payload") });
        expect(await inbox.pending("poll-proof")).toMatchObject([{ id: "e1", delivery: { data: { value: 1 } } }]);
      } finally { await f.close(); await rm(root, { recursive: true, force: true }); }
    });
  }
  it(`${mode}: poll checkpoint cannot advance before asynchronous acceptance succeeds`, async () => {
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const accepting = new Promise<void>(resolve => { reached = resolve; });
    const f = await fixture(mode, async body => { if (body.events?.length) { reached(); await gate; } });
    try {
      const sub = await f.client.subscribe("tick", { mode: "valid" });
      await accepting;
      expect(f.client.status(sub.id)[0]?.cursor).toBe("0");
      release();
      await expect.poll(() => f.client.status(sub.id)[0]?.cursor).toBe("2");
      f.client.unsubscribe(sub.id);
    } finally { release(); await f.close(); }
  });
  it(`${mode}: real SDK polling paginates catalogs, honors hints/maxAgeMs, counts duplicates and stops`, async () => {
    const f = await fixture(mode);
    try {
      await expect(f.client.subscribe("tick", { mode: "unknown" })).rejects.toThrow("inputSchema");
      await expect(f.client.subscribe("push-only", { mode: "valid" })).rejects.toThrow("poll delivery");
      const sub = await f.client.subscribe("tick", { mode: "valid" }, null, 1234);
      await f.client.poll(sub.id);
      await expect.poll(async () => (await f.inspect()).filter(row => row.method === "events/poll").length).toBe(3);
      // The acceptance sink receives all occurrences; durable deduplication is
      // its job, while the driver's delivered/duplicate counters remain unique.
      await expect.poll(() => f.deliveries.flatMap(value => value.events ?? []).length).toBe(3);
      expect(new Set(f.deliveries.flatMap(value => value.events ?? []).map(event => event.eventId)).size).toBe(2);
      const polls = (await f.inspect()).filter(row => row.method === "events/poll");
      expect(polls.map(row => row.params.cursor)).toEqual([null, "0", "1"]);
      expect(polls.every(row => row.params.maxAgeMs === 1234 && row.params.maxEvents === 50)).toBe(true);
      // The draft explicitly ignores nextPollMs while hasMore drains a backlog.
      expect(polls[2]!.at - polls[1]!.at).toBeLessThan(1000);
      expect(f.client.status(sub.id)[0]).toMatchObject({ cursor: "2", delivered: 2, duplicates: 1 });
      f.connection.lastUsedAt = 0;
      expect(f.manager.isIdle("poll", 1)).toBe(false);
      f.client.unsubscribe(sub.id);
      expect(f.connection.activeProtocolOperations).toBe(0);
      expect((await f.inspect()).filter(row => row.method === "events/poll")).toHaveLength(3);
    } finally { await f.close(); }
  });
  it(`${mode}: invalid payloads/nonadvancing backlog fail closed; null-cursor truncation is ignored`, async () => {
    const f = await fixture(mode);
    try {
      for (const mode of ["invalid", "loop"] as const) {
        const sub = await f.client.subscribe("tick", { mode });
        await expect.poll(() => f.client.status(sub.id)[0]?.status).toBe("failed");
        expect(f.deliveries.flatMap(body => body.events ?? [])).toEqual([]);
        f.client.unsubscribe(sub.id);
      }
      const gap = await f.client.subscribe("tick", { mode: "gap" });
      expect(gap).toMatchObject({ cursor: null, truncated: false });
      expect(f.deliveries.some(body => body.cursor === null && body.truncated === false && body.events.length === 0)).toBe(true);
      f.client.unsubscribe(gap.id);
    } finally { await f.close(); }
  });
  it(`${mode}: caller cancellation does not cancel the worker; unsubscribe/close cancels in-flight polling`, async () => {
    const f = await fixture(mode);
    try {
      const sub = await f.client.subscribe("tick", { mode: "pending" });
      await expect.poll(async () => (await f.inspect()).filter(row => row.method === "events/poll").length).toBe(2);
      const controller = new AbortController();
      const waiting = expect(f.client.poll(sub.id, controller.signal)).rejects.toThrow("caller cancelled");
      controller.abort(new Error("caller cancelled")); await waiting;
      expect(f.client.status(sub.id)[0]?.status).toBe("active");
      f.client.unsubscribe(sub.id);
      await expect.poll(() => f.connection.activeProtocolOperations).toBe(0);
      expect((await f.inspect()).some(row => row.method === "events/unsubscribe")).toBe(false);
    } finally { await f.close(); }
  });
}

it("actual Pi 1.3 host: canonical Events catalog and polling wake the idle model", async () => {
  const root = await mkdtemp(join(tmpdir(), "poll-pi-host-"));
  const saved = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_MCP_CONFIG_MODE: process.env.PI_MCP_CONFIG_MODE };
  const agentDir = join(root, "agent"); process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_MCP_CONFIG_MODE = "exclusive";
  let session: import("@earendil-works/pi-coding-agent").AgentSession | undefined;
  try {
    await mkdir(agentDir, { recursive: true });
    const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
    const { createCompleteMcpClient } = await import("../complete.ts");
    const faux = fauxProvider({ provider: "poll-idle-proof" });
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "cache.json"), refreshOnCreate: false, allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off" });
    const config = { mcpServers: { poll: { command: process.execPath, args: ["--input-type=module", "-e", stdioSource], protocolVersion: "2026-07-28" as const, tasks: false } }, settings: { directTools: false, autoAuth: false } };
    const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
      disabledBuiltinExtensions: ["mcp"], extensionFactories: [createCompleteMcpClient({ config })] });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    ({ session } = await createAgentSession({ cwd: root, agentDir, modelRuntime, model: faux.getModel(), resourceLoader: loader,
      settingsManager, sessionManager: SessionManager.inMemory(root), noTools: "builtin", thinkingLevel: "off" }));
    await session.bindExtensions({ mode: "print" });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("mcp_events", { action: "catalog", server: "poll" })),
      fauxAssistantMessage(fauxToolCall("mcp_events", { action: "subscribe", delivery: "poll", server: "poll", name: "tick", arguments: { mode: "valid" } })),
      fauxAssistantMessage("Waiting idle for poll."),
      context => {
        expect(JSON.stringify(context.messages)).toContain("Untrusted MCP event data");
        expect(JSON.stringify(context.messages)).toContain("e1");
        return fauxAssistantMessage("Autonomous polling woke Pi.");
      },
    ]);
    await session.prompt("List push event types, then subscribe to poll tick and wait.");
    expect(session.isStreaming).toBe(false);
    expect(faux.state.callCount).toBe(3);
    expect(session.messages.filter(message => message.role === "toolResult" && message.isError)).toEqual([]);
    await expect.poll(() => session!.messages.some(message => message.role === "assistant" && message.content.some(block => block.type === "text" && block.text === "Autonomous polling woke Pi.")), { timeout: 5000 }).toBe(true);
    await expect.poll(() => session!.isStreaming).toBe(false);
    expect(faux.state.callCount).toBe(4);
    expect(JSON.stringify(session.messages)).toContain("Untrusted MCP event data");
  } finally {
    try { if (session) { await session.abort(); await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); } }
    finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await rm(root, { recursive: true, force: true }); }
  }
}, 15000);

