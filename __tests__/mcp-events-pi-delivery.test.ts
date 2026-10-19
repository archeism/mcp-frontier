import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { installEventDelivery } from "../mcp-events-pi-delivery.ts";
import { DurableWebhookInbox } from "../mcp-events-inbox.ts";

it.each(["ENOSPC", "aborted continuation"] as const)("actual Pi %s retains the inbox without auto-retry and restart reconciles only final persisted receipts", async failure => {
  const root = await mkdtemp(join(tmpdir(), "event-receipt-enospc-"));
  const originalAppend = fs.appendFileSync;
  let session: import("@earendil-works/pi-coding-agent").AgentSession | undefined;
  const inbox = new DurableWebhookInbox(join(root, "inbox"));
  try {
    const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const { fauxProvider, fauxAssistantMessage } = await import("@earendil-works/pi-ai/providers/faux");
    const agentDir = join(root, "agent"); await mkdir(agentDir);
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null,
      modelsStorePath: join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    const faux = fauxProvider({ provider: "receipt-enospc" }); runtime.registerNativeProvider(faux.provider);
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off" }); settingsManager.setRetryEnabled(false);
    let manager = SessionManager.create(root, join(root, "sessions"));
    const scope = manager.getSessionId() + "/sub";
    await inbox.accept(scope, "event", { eventId: "event", name: "tick", timestamp: new Date().toISOString(), data: {} });
    let acknowledgeFails = false, acknowledgements = 0, failedWrites = 0;
    const start = async (continueOnce = false) => {
      let bridge!: ReturnType<typeof installEventDelivery>, settled!: () => void;
      const finished = new Promise<void>(resolve => { settled = resolve; });
      const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true,
        noPromptTemplates: true, noThemes: true, noContextFiles: true, disabledBuiltinExtensions: ["mcp"], extensionFactories: [pi => {
          bridge = installEventDelivery(pi, {
            pending: async () => (await inbox.pending(scope)).map(row => ({ ...row, server: "fixture", subscriptionId: "sub" })),
            acknowledge: async rows => {
              if (acknowledgeFails) throw new Error("Fixture acknowledgement unavailable");
              for (const row of rows) { await inbox.acknowledge(scope, row.id); acknowledgements++; }
            },
          });
          let continued = false;
          pi.on("agent_before_settle", event => {
            if (!continueOnce || continued) return;
            continued = true;
            return { continue: true, entries: [...event.entries, { type: "custom_message", customType: "fixture-continuation",
              content: "Continue before final settlement.", display: false }] };
          });
          pi.on("agent_settled", () => { settled(); });
        }] });
      await loader.reload();
      ({ session } = await createAgentSession({ cwd: root, agentDir, modelRuntime: runtime, model: faux.getModel(), thinkingLevel: "off",
        resourceLoader: loader, settingsManager, sessionManager: manager, noTools: "builtin" }));
      await session.bindExtensions({ mode: "tui", onError() {} });
      return { bridge, finished };
    };
    const close = async () => { await session!.abort(); await session!.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session!.dispose(); session = undefined; };
    const hasReceipt = (value: typeof manager) => value.getEntries().some(entry => entry.type === "custom" && entry.customType === "mcp-events-consumed");
    const first = await start(failure === "aborted continuation");
    fs.appendFileSync = ((path, data, ...args) => {
      if (failure === "ENOSPC" && String(data).includes('"customType":"mcp-events-consumed"')) {
        failedWrites++; throw Object.assign(new Error("Fixture receipt ENOSPC"), { code: "ENOSPC" });
      }
      return originalAppend(path, data, ...args);
    }) as typeof fs.appendFileSync;
    syncBuiltinESMExports();
    let entered!: () => void, release!: () => void;
    const continuing = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    faux.setResponses([fauxAssistantMessage("Processed before final settlement."), ...(failure === "aborted continuation" ? [async () => {
      entered(); await gate; return fauxAssistantMessage("", { stopReason: "aborted" });
    }] : [])]);
    await first.bridge.notify();
    if (failure === "aborted continuation") { await continuing; const aborting = session!.abort(); release(); await aborting; }
    await first.finished;
    expect(failedWrites).toBe(failure === "ENOSPC" ? 1 : 0);
    if (failure === "ENOSPC") expect(hasReceipt(manager)).toBe(true);
    const file = manager.getSessionFile()!;
    expect(hasReceipt(SessionManager.open(file))).toBe(false);
    expect(acknowledgements).toBe(0);
    expect(await inbox.pending(scope)).toHaveLength(1);
    await new Promise<void>(resolve => setImmediate(resolve));
    const callsBeforeRestart = failure === "ENOSPC" ? 1 : 2;
    expect(faux.state.callCount).toBe(callsBeforeRestart);
    fs.appendFileSync = originalAppend; syncBuiltinESMExports(); await close();

    // A failed memory-only receipt must not suppress delivery after restart.
    manager = SessionManager.open(file); acknowledgeFails = true;
    const second = await start();
    faux.setResponses([fauxAssistantMessage("Processed with persisted receipt.")]);
    await second.bridge.notify(); await second.finished;
    expect(faux.state.callCount).toBe(callsBeforeRestart + 1); expect(hasReceipt(SessionManager.open(file))).toBe(true);
    expect(await inbox.pending(scope)).toHaveLength(1); await close();

    // A persisted receipt reconciles a lost inbox acknowledgement, without model replay.
    manager = SessionManager.open(file); acknowledgeFails = false;
    const third = await start(); await third.bridge.notify();
    expect(await inbox.pending(scope)).toHaveLength(0);
    expect(acknowledgements).toBe(1); expect(faux.state.callCount).toBe(callsBeforeRestart + 1);
  } finally {
    fs.appendFileSync = originalAppend; syncBuiltinESMExports();
    if (session) { await session.abort(); await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

it("bounds a valid large push-event batch by encoded bytes before queueing it into Pi", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const sent: any[] = [];
  const api = { on: (name: string, handler: (...args: any[]) => any) => { handlers.set(name, handler); return () => {}; },
    sendMessage: (message: any) => { sent.push(message); } } as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
  const ctx = { sessionManager: { getSessionId: () => "session", getEntries: () => [] } };
  const pending = ["first", "second"].map(id => ({ subscriptionId: "sub", id, server: "fixture", delivery: {
    eventId: id, name: "tick", timestamp: new Date().toISOString(), data: { text: "x".repeat(600 * 1024) } } }));
  const bridge = installEventDelivery(api, { pending: async () => pending, acknowledge: async () => {} });
  handlers.get("session_start")!({}, ctx); await bridge.notify();
  expect(sent).toHaveLength(1);
  expect(Buffer.byteLength(sent[0].content)).toBeLessThanOrEqual(1024 * 1024);
  expect(sent[0].details.deliveries).toHaveLength(1);
});

it("an old settlement awaiting acknowledgement cannot erase a replacement Pi session's delivery tracking", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const sent: any[] = [];
  let activeEntries: any[] = [];
  const api = { on: (name: string, handler: (...args: any[]) => any) => { handlers.set(name, handler); return () => {}; },
    appendEntry: (customType: string, data: unknown) => activeEntries.push({ type: "custom", customType, data }),
    sendMessage: (message: any) => { sent.push(message); } } as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
  const makeContext = (id: string) => {
    const entries: any[] = [];
    return { entries, ctx: { sessionManager: { getSessionId: () => id, getEntries: () => entries } } };
  };
  const a = makeContext("session-a"), b = makeContext("session-b");
  const row = (id: string) => ({ subscriptionId: id, id, server: "fixture", delivery: {
    eventId: id, name: "tick", timestamp: new Date().toISOString(), data: {} } });
  let pending = [row("a")], release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const accepting = new Promise<void>(resolve => { entered = resolve; });
  const bridge = installEventDelivery(api, { pending: async () => pending, acknowledge: async () => { entered(); await gate; } });
  activeEntries = a.entries; handlers.get("session_start")!({}, a.ctx); await bridge.notify();
  handlers.get("message_start")!({ message: { role: "custom", ...sent.at(-1) } });
  handlers.get("agent_before_settle")!({ outcome: "completed" });
  const settling = handlers.get("agent_settled")!({}, a.ctx); await accepting;
  activeEntries = b.entries; handlers.get("session_start")!({}, b.ctx); pending = [row("b")]; await bridge.notify();
  handlers.get("message_start")!({ message: { role: "custom", ...sent.at(-1) } });
  release(); await settling;
  handlers.get("agent_before_settle")!({ outcome: "completed" }); pending = [];
  await handlers.get("agent_settled")!({ aborted: false }, b.ctx);
  expect(b.entries.at(-1)?.data).toEqual({ version: 2, sessionId: "session-b", deliveries: [{ subscriptionId: "b", id: "b" }] });
});

it.each(["settlement", "reconcile"])("a delayed %s receipt read captures old identity and cannot acknowledge after session replacement", async path => {
  const handlers = new Map<string, (...args: any[]) => any>(), sent: any[] = [], acknowledgements: unknown[] = [];
  const entries: any[] = [];
  const api = { on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    sendMessage: (message: unknown) => sent.push(message) } as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
  let sessionId = "old", file: string | undefined;
  const ctx = { sessionManager: { getSessionId: () => sessionId, getSessionFile: () => file, getEntries: () => entries } };
  const row = { subscriptionId: "sub", id: "event", server: "fixture", delivery: {
    eventId: "event", name: "tick", timestamp: new Date().toISOString(), data: {} } };
  const bridge = installEventDelivery(api, { pending: async () => [row], acknowledge: async rows => { acknowledgements.push(rows); } });
  handlers.get("session_start")!({}, ctx);
  if (path === "settlement") {
    await bridge.notify(); handlers.get("message_start")!({ message: { role: "custom", ...sent[0] } });
    handlers.get("agent_before_settle")!({ outcome: "completed" });
  }
  file = "/fixture/old-session.jsonl";
  const original = fs.createReadStream, stream = new PassThrough(); stream.setEncoding("utf8");
  let entered!: () => void; const reading = new Promise<void>(resolve => { entered = resolve; });
  fs.createReadStream = ((value: unknown) => { expect(value).toBe("/fixture/old-session.jsonl"); entered(); return stream; }) as typeof fs.createReadStream;
  syncBuiltinESMExports();
  try {
    const pending = path === "settlement" ? handlers.get("agent_settled")!({ aborted: false }, ctx) : bridge.notify();
    await reading;
    sessionId = "new"; file = "/fixture/new-session.jsonl"; handlers.get("session_start")!({}, ctx);
    stream.end(JSON.stringify({ type: "custom", customType: "mcp-events-consumed", data: {
      version: 2, sessionId: "old", deliveries: [{ subscriptionId: "sub", id: "event" }] } }) + "\n");
    await pending; expect(acknowledgements).toEqual([]);
    expect(sent).toHaveLength(path === "settlement" ? 1 : 0);
  } finally { fs.createReadStream = original; syncBuiltinESMExports(); stream.destroy(); }
});

it("persistent reconciliation ignores oversized, legacy, invalid and incomplete receipt rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "receipt-invalid-")), file = join(root, "session.jsonl");
  const handlers = new Map<string, (...args: any[]) => any>(), sent: unknown[] = [], acked: unknown[] = [];
  const api = { on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler), sendMessage: (value: unknown) => sent.push(value) } as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
  const data = { sessionId: "session", deliveries: [{ subscriptionId: "sub", id: "event" }] };
  const entry = (data: unknown) => JSON.stringify({ type: "custom", customType: "mcp-events-consumed", data });
  const ctx = { sessionManager: { getSessionId: () => "session", getSessionFile: () => file,
    getEntries: () => [{ type: "custom", customType: "mcp-events-consumed", data: { ...data, version: 2 } }] } };
  const bridge = installEventDelivery(api, { pending: async () => acked.length ? [] : [{ subscriptionId: "sub", id: "event", server: "fixture", delivery: {
    eventId: "event", name: "tick", timestamp: new Date().toISOString(), data: {} } }], acknowledge: async rows => { acked.push(rows); } });
  try {
    await writeFile(file, JSON.stringify({ type: "message", content: "x".repeat(3 * 1024 * 1024) }) + "\n" + entry(data) + "\n"
      + entry({ ...data, version: 2, padding: "x".repeat(2 * 1024 * 1024) }) + "\n"
      + entry({ version: 2, sessionId: "session", deliveries: "invalid" }) + "\n" + entry({ ...data, version: 2 }));
    handlers.get("session_start")!({}, ctx); await bridge.notify();
    expect(acked).toEqual([]); expect(sent).toHaveLength(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("Pi consumes a durable event in a real agent run before acknowledging it, not when merely queued", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-event-receipt-"));
  let session: import("@earendil-works/pi-coding-agent").AgentSession | undefined;
  try {
    const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const { fauxProvider, fauxAssistantMessage } = await import("@earendil-works/pi-ai/providers/faux");
    const agentDir = join(root, "agent"); await mkdir(agentDir);
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null,
      modelsStorePath: join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    const faux = fauxProvider({ provider: "events-receipts" }); modelRuntime.registerNativeProvider(faux.provider);
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off" });
    settingsManager.setRetryEnabled(false);
    const sessionManager = SessionManager.inMemory(root);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const acknowledged: string[] = [];
    const pending = [{ subscriptionId: "sub", id: "e1", server: "fixture", delivery: {
      eventId: "e1", name: "tick", timestamp: new Date().toISOString(), data: { proof: "durable-event" } } }];
    let bridge!: ReturnType<typeof installEventDelivery>;
    const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true,
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, disabledBuiltinExtensions: ["mcp"],
      extensionFactories: [pi => { bridge = installEventDelivery(pi, {
        pending: async () => pending.filter(row => !acknowledged.includes(row.id)),
        acknowledge: async rows => {
          expect(sessionManager.getEntries().some(entry => entry.type === "custom" && entry.customType === "mcp-events-consumed")).toBe(true);
          for (const row of rows) if (!acknowledged.includes(row.id)) acknowledged.push(row.id);
        },
      }); }],
    });
    await loader.reload(); expect(loader.getExtensions().errors).toEqual([]);
    ({ session } = await createAgentSession({ cwd: root, agentDir, modelRuntime, model: faux.getModel(), thinkingLevel: "off",
      resourceLoader: loader, settingsManager, sessionManager, noTools: "builtin" }));
    await session.bindExtensions({ mode: "tui" });
    faux.setResponses([async context => {
      expect(JSON.stringify(context.messages)).toContain("durable-event");
      entered(); await gate; return fauxAssistantMessage("Event processed.");
    }]);
    await bridge.notify(); await started;
    expect(acknowledged).toEqual([]);
    await bridge.notify(); // A duplicate pending notification does not enqueue another turn.
    release();
    await expect.poll(() => acknowledged).toEqual(["e1"]);
    await expect.poll(() => session!.isStreaming).toBe(false);
    expect(faux.state.callCount).toBe(1);
    for (let i = 0; i < 101; i++) pending.push({ subscriptionId: "sub", id: `backlog-${i}`, server: "fixture",
      delivery: { eventId: `backlog-${i}`, name: "tick", timestamp: new Date().toISOString(), data: { proof: "backlog" } } });
    faux.setResponses([fauxAssistantMessage("First bounded batch processed."), fauxAssistantMessage("Remaining backlog processed.")]);
    await bridge.notify();
    await expect.poll(() => acknowledged.length, { timeout: 2000 }).toBe(102);
    await expect.poll(() => session!.isStreaming).toBe(false);
    expect(faux.state.callCount).toBe(3);
    pending.push({ subscriptionId: "sub", id: "failed-run", server: "fixture", delivery: {
      eventId: "failed-run", name: "tick", timestamp: new Date().toISOString(), data: { proof: "retry after failure" } } });
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "Fixture provider failure" })]);
    await bridge.notify();
    await expect.poll(() => faux.state.callCount).toBe(4);
    await expect.poll(() => session!.isStreaming).toBe(false);
    expect(acknowledged).not.toContain("failed-run");
    faux.setResponses([fauxAssistantMessage("Successfully processed on explicit retry.")]);
    await bridge.notify();
    await expect.poll(() => acknowledged).toContain("failed-run");
    expect(faux.state.callCount).toBe(5);
    let releaseBatch!: () => void;
    const holdBatch = new Promise<void>(resolve => { releaseBatch = resolve; });
    let batchStarted!: () => void;
    const firstBatchStarted = new Promise<void>(resolve => { batchStarted = resolve; });
    for (let i = 0; i < 100; i++) pending.push({ subscriptionId: "sub", id: `concurrent-${i}`, server: "fixture",
      delivery: { eventId: `concurrent-${i}`, name: "tick", timestamp: new Date().toISOString(), data: { proof: "concurrent batch" } } });
    faux.setResponses([async () => { batchStarted(); await holdBatch; return fauxAssistantMessage("First concurrent batch processed."); },
      fauxAssistantMessage("Second concurrent batch processed.")]);
    await bridge.notify(); await firstBatchStarted;
    for (let i = 100; i < 200; i++) pending.push({ subscriptionId: "sub", id: `concurrent-${i}`, server: "fixture",
      delivery: { eventId: `concurrent-${i}`, name: "tick", timestamp: new Date().toISOString(), data: { proof: "concurrent batch" } } });
    await bridge.notify(); releaseBatch();
    await expect.poll(() => acknowledged.filter(id => id.startsWith("concurrent-")).length, { timeout: 2000 }).toBe(200);
  } finally {
    if (session) { await session.abort(); await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
