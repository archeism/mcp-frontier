import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { installCanonicalEvents } from "../mcp-events.ts";
import { DurableWebhookInbox } from "../mcp-events-inbox.ts";
import { EventsRegistry } from "../mcp-events-registry.ts";
import { MCP_PROTOCOL_EVENT, createProtocolSession, type McpProtocol, type McpProtocolSession } from "../runtime-protocol.ts";
import { EVENTS_COORDINATOR_PROTOCOL } from "../mcp-events-coordinator.ts";
import { EventsCoordinator } from "../mcp-events-coordinator.ts";
import { McpServerManager } from "../server-manager.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const event = { eventId: "old-event", name: "tick", timestamp: "2026-10-17T00:00:00Z", data: { marker: "old-session-private" } };
const page = (events: typeof event[] = []) => ({ events, cursor: "c1", nextPollMs: 3_600_000 });

/** Real Pi extension loading and contexts; only the mediated remote protocol is
 * controlled. Lifecycle callbacks are dispatched explicitly so reset can be
 * held at a deterministic gate without depending on UI scheduling/timers. */
async function fixture(externalProtocol?: McpProtocol) {
  const root = await mkdtemp(join(tmpdir(), "events-installer-"));
  const agentDir = join(root, "agent"); await mkdir(agentDir);
  const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const { fauxProvider, fauxAssistantMessage } = await import("@earendil-works/pi-ai/providers/faux");
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null,
    modelsStorePath: join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  const faux = fauxProvider({ provider: "installer-regressions" }); runtime.registerNativeProvider(faux.provider);
  faux.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage("Processed.")));
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off" });
  settingsManager.setRetryEnabled(false);
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => any>>();
  const messages: unknown[] = [];
  const queuedMessages: unknown[] = [];
  let registrationAttempts = 0, failRegistration = false;
  const pollEntered = gate<void>(), pollReply = gate<ReturnType<typeof page>>();
  const protocolSession: McpProtocolSession = {
    signal: new AbortController().signal, protocolVersion: "2026-07-28", serverCapabilities: {}, serverBinding: "controlled-endpoint",
    getEventsCapabilities: async () => ({}),
    watchNotifications: () => ({ close() {}, closed: new Promise(() => {}) }),
    openStream: () => { throw new Error("Unexpected stream"); }, close() {},
    async request(method) {
      if (method === "events/list") return { events: [{ name: "tick", delivery: ["poll"], inputSchema: { type: "object" }, payloadSchema: { type: "object" } }] };
      if (method === "events/poll") { pollEntered.resolve(); return pollReply.promise; }
      throw new Error(`Unexpected request ${method}`);
    },
  };
  const protocol: McpProtocol = { connect: async () => protocolSession, dispose() {} };
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, disabledBuiltinExtensions: ["mcp"],
    extensionFactories: [pi => {
      pi.events.on(MCP_PROTOCOL_EVENT, request => {
        registrationAttempts++;
        if (failRegistration) { request.error = new Error("Controlled registration rejection"); failRegistration = false; }
        else request.result = externalProtocol ?? protocol;
      });
      // Capture the actual public registrations, not replacement modules.
      installCanonicalEvents({ ...pi, sendMessage: ((message, options) => {
        queuedMessages.push(message); pi.sendMessage(message, options);
      }) as typeof pi.sendMessage, on: ((name: string, handler: any) => {
        const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list);
        pi.on(name as any, handler);
      }) as typeof pi.on }, { storageRoot: root });
      pi.on("message_start", e => { if (e.message.role === "custom" && e.message.customType === "mcp-events") messages.push(e.message); });
    }],
  });
  await loader.reload(); expect(loader.getExtensions().errors).toEqual([]);
  const manager = SessionManager.inMemory(root);
  const { session } = await createAgentSession({ cwd: root, agentDir, modelRuntime: runtime, model: faux.getModel(),
    thinkingLevel: "off", resourceLoader: loader, settingsManager, sessionManager: manager, noTools: "builtin" });
  await session.bindExtensions({ mode: "tui" });
  const original = session.extensionRunner.createContext();
  const nextManager = SessionManager.inMemory(root);
  const next = { ...original, sessionManager: nextManager } as ExtensionContext;
  const tool = loader.getExtensions().extensions.flatMap(ext => [...ext.tools.values()]).find(t => t.definition.name === "mcp_events")!.definition;
  const dispatch = async (name: string, ctx = original, data = {}) => {
    for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...data }, ctx);
  };
  const execute = (args: any, ctx = original) => tool.execute("fixture-call", args, undefined, undefined, ctx);
  const directory = (ctx: ExtensionContext) => join(root, createHash("sha256").update(ctx.sessionManager.getSessionId()).digest("hex"));
  return { root, session, original, next, nextManager, messages, queuedMessages, pollEntered, pollReply, directory, dispatch, execute,
    failNextRegistration() { failRegistration = true; }, attempts: () => registrationAttempts,
    async close() {
      pollReply.resolve(page());
      await session.abort(); await dispatch("session_shutdown"); session.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

it("detaches the old inbox before awaiting reset teardown at the public Pi lifecycle boundary", async () => {
  const f = await fixture();
  let subscription: Promise<unknown> | undefined, switching: Promise<unknown> | undefined;
  try {
    subscription = f.execute({ action: "subscribe", server: "fixture", name: "tick", delivery: "poll" });
    await f.pollEntered.promise;
    const stored = JSON.parse(await readFile(join(f.directory(f.original), "subscriptions.json"), "utf8"));
    const id = stored.entries[0].id;
    const inbox = new DurableWebhookInbox(join(f.root, "inbox"));
    await inbox.accept(`${f.original.sessionManager.getSessionId()}/${id}`, event.eventId, event);
    // The first start handler rebinds the bridge; the second must detach before
    // waiting for the outstanding subscription operation to finish.
    switching = f.dispatch("session_start", f.next);
    await Promise.resolve(); await Promise.resolve();
    let switched = false; void switching.then(() => { switched = true; });
    expect(switched).toBe(false);
    await f.dispatch("agent_before_settle", f.next, { outcome: "completed" });
    await f.dispatch("agent_settled", f.next);
    expect(f.queuedMessages).toEqual([]);
    await expect.poll(() => f.session.isStreaming).toBe(false);
    expect(f.messages).toEqual([]);
    expect(await inbox.pending(`${f.original.sessionManager.getSessionId()}/${id}`)).toHaveLength(1);
  } finally {
    f.pollReply.resolve(page()); await subscription; await switching; await f.close();
  }
}, 15000);

it("a retiring coordinator's accepted event cannot wake/read the newly bound Pi session", async () => {
  const f = await fixture();
  let subscription: Promise<unknown> | undefined, switching: Promise<unknown> | undefined;
  const entries = vi.spyOn(f.nextManager, "getEntries");
  try {
    subscription = f.execute({ action: "subscribe", server: "fixture", name: "tick", delivery: "poll" });
    await f.pollEntered.promise;
    switching = f.dispatch("session_start", f.next);
    await Promise.resolve(); await Promise.resolve();
    // The outstanding first poll is accepted while close waits for subscribe.
    // An unbound onPending would call bridge.notify and read new-session receipts
    // even with synchronous coordinator detachment already in place.
    entries.mockClear(); f.pollReply.resolve(page([event]));
    await subscription; await switching;
    expect(entries).not.toHaveBeenCalled();
    expect(f.queuedMessages).toEqual([]);
    expect(f.messages).toEqual([]);
    const stored = JSON.parse(await readFile(join(f.directory(f.original), "subscriptions.json"), "utf8"));
    const inbox = new DurableWebhookInbox(join(f.root, "inbox"));
    expect(await inbox.pending(`${f.original.sessionManager.getSessionId()}/${stored.entries[0].id}`)).toHaveLength(1);
  } finally {
    entries.mockRestore(); f.pollReply.resolve(page()); await subscription; await switching; await f.close();
  }
}, 15000);

it.each(["same", "mixed", "shutdown"] as const)("overlapping %s lifecycle waits for actual registry teardown without reviving stale context", async mode => {
  const f = await fixture();
  const entered = gate<void>(), release = gate<void>();
  const close = EventsCoordinator.prototype.close;
  let held = false;
  const spy = vi.spyOn(EventsCoordinator.prototype, "close").mockImplementation(async function () {
    if (!held) { held = true; entered.resolve(); await release.promise; }
    return close.call(this);
  });
  let first: Promise<unknown> | undefined, last: Promise<unknown> | undefined, tool: Promise<any> | undefined;
  try {
    expect(await f.execute({ action: "list" })).not.toMatchObject({ isError: true });
    first = f.dispatch("session_start", f.original); await entered.promise;
    const target = mode === "mixed" ? f.next : f.original;
    last = f.dispatch(mode === "shutdown" ? "session_shutdown" : "session_start", target);
    let settled = false; void last.then(() => { settled = true; }, () => { settled = true; });
    // dispatch first awaits the bridge's separate synchronous handler. Let the
    // installer enter reset before issuing a tool for that new generation.
    await Promise.resolve();
    tool = f.execute({ action: "list" }, target);
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    // The held owner still owns the real SQLite lease.
    await expect(EventsRegistry.open(f.directory(f.original), f.original.sessionManager.getSessionId())).rejects.toThrow("already owned");
    release.resolve(); await Promise.all([first, last]);
    const result = await tool;
    if (mode === "shutdown") {
      expect(result).toMatchObject({ isError: true });
      expect(await f.execute({ action: "list" })).toMatchObject({ isError: true });
      const lease = await EventsRegistry.open(f.directory(f.original), f.original.sessionManager.getSessionId()); await lease.close();
    } else {
      expect(result).not.toMatchObject({ isError: true });
      expect(await f.execute({ action: "list" }, target)).not.toMatchObject({ isError: true });
      if (mode === "mixed") expect(await f.execute({ action: "list" }, f.original)).toMatchObject({ isError: true });
    }
  } finally {
    release.resolve(); await Promise.allSettled([first, last, tool].filter(Boolean)); spy.mockRestore(); await f.close();
  }
}, 15000);

it("releases the real registry lease after protocol registration rejection so the same Pi tool can retry", async () => {
  const f = await fixture();
  try {
    f.failNextRegistration();
    const rejected = await f.execute({ action: "list" });
    expect(rejected).toMatchObject({ isError: true });
    // Independently acquire the same on-disk lease, not a mocked close assertion.
    const lease = await EventsRegistry.open(f.directory(f.original), f.original.sessionManager.getSessionId());
    await lease.close();
    expect(await f.execute({ action: "list" })).toMatchObject({ content: [{ type: "text", text: "[]" }] });
    expect(f.attempts()).toBe(2);
  } finally { await f.close(); }
}, 15000);

it("pins the shared inbox across same-session restart despite a newly created empty session inbox directory", async () => {
  const f = await fixture();
  try {
    f.pollReply.resolve(page());
    const response = await f.execute({ action: "subscribe", server: "fixture", name: "tick", delivery: "poll" });
    const sub = JSON.parse((response.content[0] as { text: string }).text);
    await f.execute({ action: "unsubscribe", subscription_id: sub.id });
    const inbox = new DurableWebhookInbox(join(f.root, "inbox"));
    await inbox.accept(`${f.original.sessionManager.getSessionId()}/${sub.id}`, event.eventId, event);
    await f.dispatch("session_shutdown");
    await mkdir(join(f.directory(f.original), "inbox"));
    f.queuedMessages.length = 0;
    await f.dispatch("session_start");
    await expect.poll(() => f.queuedMessages.length).toBe(1);
    expect(JSON.stringify(f.queuedMessages)).toContain("old-session-private");
    const snapshot = JSON.parse(await readFile(join(f.directory(f.original), "subscriptions.json"), "utf8"));
    expect(snapshot.inboxLocation).toBe("shared");
  } finally { await f.close(); }
}, 15000);

it.each([false, true])("a pinned shared inbox rejects newly populated session storage on reopen (shared acknowledged=%s)", async acknowledged => {
  const f = await fixture();
  try {
    f.pollReply.resolve(page());
    const response = await f.execute({ action: "subscribe", server: "fixture", name: "tick", delivery: "poll" });
    const sub = JSON.parse((response.content[0] as { text: string }).text);
    await f.execute({ action: "unsubscribe", subscription_id: sub.id });
    const scope = `${f.original.sessionManager.getSessionId()}/${sub.id}`;
    const shared = new DurableWebhookInbox(join(f.root, "inbox"));
    await shared.accept(scope, event.eventId, event);
    if (acknowledged) await shared.acknowledge(scope, event.eventId);
    await f.dispatch("session_shutdown");
    const local = new DurableWebhookInbox(join(f.directory(f.original), "inbox"));
    await local.accept(scope, event.eventId, event);
    const registrations = f.attempts();
    await expect(f.dispatch("session_start")).rejects.toThrow(/inbox.*conflict/i);
    expect(f.attempts()).toBe(registrations);
    expect(JSON.parse(await readFile(join(f.directory(f.original), "subscriptions.json"), "utf8")).inboxLocation).toBe("shared");
    expect(await local.pending(scope)).toHaveLength(1);
    expect(await shared.accept(scope, event.eventId, event)).toBe(false);
    const lease = await EventsRegistry.open(f.directory(f.original), f.original.sessionManager.getSessionId()); await lease.close();
  } finally { await f.close(); }
}, 15000);

it("preserves populated session storage without rejecting unrelated shared-session records", async () => {
  const f = await fixture();
  try {
    const ownScope = `${f.original.sessionManager.getSessionId()}/legacy-sub`;
    const local = new DurableWebhookInbox(join(f.directory(f.original), "inbox"));
    const shared = new DurableWebhookInbox(join(f.root, "inbox"));
    await local.accept(ownScope, event.eventId, event);
    await shared.accept("other-session/sub", event.eventId, event);
    expect((await f.execute({ action: "list" })).isError).not.toBe(true);
    const snapshot = JSON.parse(await readFile(join(f.directory(f.original), "subscriptions.json"), "utf8"));
    expect(snapshot.inboxLocation).toBe("session");
    await f.dispatch("session_shutdown"); await f.dispatch("session_start");
    expect((await f.execute({ action: "list" })).isError).not.toBe(true);
    expect(await local.pending(ownScope)).toHaveLength(1);
    expect(await shared.pending("other-session/sub")).toHaveLength(1);
  } finally { await f.close(); }
}, 15000);

it.each([false, true])("a pinned session inbox rejects newly retained shared records for this session (acknowledged=%s)", async acknowledged => {
  const f = await fixture();
  try {
    const scope = `${f.original.sessionManager.getSessionId()}/legacy-sub`;
    const local = new DurableWebhookInbox(join(f.directory(f.original), "inbox"));
    await local.accept(scope, event.eventId, event);
    expect((await f.execute({ action: "list" })).isError).not.toBe(true);
    await f.dispatch("session_shutdown");
    const shared = new DurableWebhookInbox(join(f.root, "inbox"));
    await shared.accept(scope, event.eventId, event);
    if (acknowledged) await shared.acknowledge(scope, event.eventId);
    await expect(f.dispatch("session_start")).rejects.toThrow(/inbox.*conflict/i);
    expect(JSON.parse(await readFile(join(f.directory(f.original), "subscriptions.json"), "utf8")).inboxLocation).toBe("session");
    expect(await local.pending(scope)).toHaveLength(1);
    expect(await shared.accept(scope, event.eventId, event)).toBe(false);
  } finally { await f.close(); }
}, 15000);

it.each([false, true])("fails closed on populated session storage plus this session's shared retained records (acknowledged=%s)", async acknowledged => {
  const f = await fixture();
  try {
    const scope = `${f.original.sessionManager.getSessionId()}/legacy-sub`;
    const local = new DurableWebhookInbox(join(f.directory(f.original), "inbox"));
    const shared = new DurableWebhookInbox(join(f.root, "inbox"));
    await local.accept(scope, event.eventId, event); await shared.accept(scope, event.eventId, event);
    if (acknowledged) await shared.acknowledge(scope, event.eventId);
    expect(await f.execute({ action: "list" })).toMatchObject({ isError: true });
    expect(f.attempts()).toBe(0);
    expect(await local.pending(scope)).toHaveLength(1);
    expect(await shared.accept(scope, event.eventId, event)).toBe(false);
    const lease = await EventsRegistry.open(f.directory(f.original), f.original.sessionManager.getSessionId()); await lease.close();
  } finally { await f.close(); }
}, 15000);

it("does not return a real events/list JSON-RPC error's credential to the Pi model", async () => {
  const credential = "fake-events-credential-DO-NOT-EXPOSE";
  const calls: string[] = [];
  const http = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const frame = JSON.parse(body); calls.push(frame.method);
    if (frame.id === undefined) { res.writeHead(202).end(); return; }
    res.writeHead(200, { "content-type": "application/json" });
    const result = (value: object) => res.end(JSON.stringify({ jsonrpc: "2.0", id: frame.id,
      result: { resultType: "complete", ttlMs: 0, cacheScope: "private", ...value } }));
    if (frame.method === "server/discover") result({ supportedVersions: ["2026-07-28"], capabilities: { events: {} } });
    else if (frame.method === "events/list") res.end(JSON.stringify({ jsonrpc: "2.0", id: frame.id,
      error: { code: -32001, message: `Private connection failed: Authorization Bearer ${credential}`, data: { privatePath: "/private/fixture/auth.json" } } }));
    else result({ tools: [] });
  });

  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const address = http.address(); if (!address || typeof address === "string") throw new Error("No fixture address");
  const manager = new McpServerManager(process.cwd());
  const owner = new AbortController();
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    const connection = await manager.connect("fixture", { url: `http://127.0.0.1:${address.port}/mcp`, auth: false,
      protocolVersion: "2026-07-28", tasks: false });
    f = await fixture({ connect: async () => createProtocolSession(connection, owner.signal, EVENTS_COORDINATOR_PROTOCOL, "fixture"), dispose() {} });
    const result = await f.execute({ action: "catalog", server: "fixture" });
    expect(calls).toContain("events/list");
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).not.toContain(credential);
    expect(JSON.stringify(result)).not.toContain("/private/fixture/auth.json");
  } finally {
    await f?.close(); owner.abort(); await manager.closeAll(); http.closeAllConnections();
    await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
  }
}, 15000);
