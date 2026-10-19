import { spawn } from "node:child_process";
import { once } from "node:events";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { McpServerManager } from "../server-manager.ts";
import { createProtocolSession } from "../runtime-protocol.ts";
import { callToolViaTaskSession } from "../mcp-tasks.ts";
import { EVENTS_PROTOCOL } from "../event-companion/src/protocol.ts";
import { EventConnection } from "../event-companion/src/stream.ts";

const fixture = fileURLToPath(new URL("./fixtures/complete-server.mjs", import.meta.url));
type Profile = "modern" | "legacy" | "unsupported";

async function start(mode: "stdio" | "http", profile: Profile = "modern") {
  const manager = new McpServerManager(process.cwd());
  const owner = new AbortController();
  const child = mode === "http" ? spawn(process.execPath, [fixture, mode, profile], { stdio: ["ignore", "pipe", "pipe"] }) : undefined;
  let stderr = "";
  child?.stderr.on("data", chunk => { stderr += chunk; });
  try {
    let endpoint: { command: string; args: string[] } | { url: string; auth: false };
    if (child) {
      const lines = readline.createInterface({ input: child.stdout });
      let startupTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const line = await Promise.race([
          once(lines, "line").then(([line]) => String(line)),
          once(child, "exit").then(([code]) => { throw new Error(`HTTP fixture exited ${code}: ${stderr}`); }),
          new Promise<never>((_, reject) => {
            startupTimer = setTimeout(() => reject(new Error(`HTTP fixture startup timed out: ${stderr}`)), 5000);
            startupTimer.unref();
          }),
        ]);
        endpoint = { url: JSON.parse(line).url, auth: false };
      } finally { clearTimeout(startupTimer); lines.close(); }
    } else endpoint = { command: process.execPath, args: [fixture, mode, profile] };
    const connection = await manager.connect("complete", { ...endpoint, protocolVersion: profile === "legacy" ? "auto" : "2026-07-28", tasks: true });
    return {
      manager, owner, connection,
      async inspect() {
        const result = await connection.client.callTool({ name: "inspect", arguments: {} });
        const content = result.content[0];
        if (content.type !== "text") throw new Error("Expected fixture inspection text");
        return JSON.parse(content.text) as { log: Array<{ method: string; id: string; params: any; headers: Record<string, string> }> };
      },
      async close() {
        owner.abort();
        await manager.closeAll();
        if (child && child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill();
          await exited;
        }
      },
    };
  } catch (error) {
    owner.abort();
    await manager.closeAll();
    child?.kill();
    throw error;
  }
}

for (const mode of ["stdio", "http"] as const) describe(`complete protocol over ${mode}`, () => {
  it("push cursor and notification wait for asynchronous event acceptance", async () => {
    const f = await start(mode);
    const session = createProtocolSession(f.connection, f.owner.signal, EVENTS_PROTOCOL);
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const accepting = new Promise<void>(resolve => { reached = resolve; });
    const received: unknown[] = [];
    let acceptanceStarted = false;
    const events = new EventConnection("complete", session, (_sub, event) => { received.push(event); }, undefined, undefined, 15000,
      { acceptEvent: async () => { acceptanceStarted = true; reached(); await gate; } });
    try {
      const sub = await events.subscribe("tick", {});
      const before = sub.cursor;
      await f.connection.client.callTool({ name: "emit", arguments: { subscriptionId: sub.id, value: "durable" } });
      await expect.poll(() => acceptanceStarted || received.length > 0).toBe(true);
      expect(acceptanceStarted).toBe(true);
      await accepting;
      expect(sub.cursor).toBe(before);
      expect(received).toEqual([]);
      release();
      await expect.poll(() => received.length).toBe(1);
      await expect.poll(() => sub.cursor).toBe("2");
    } finally { release(); events.close(); await f.close(); }
  });
  it("uses baseline SDK operations alongside official task handles, polling, input updates and remote cancellation", async () => {
    const f = await start(mode);
    try {
      const { client, taskSession } = f.connection;
      expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
      expect(taskSession?.capabilities.execution).toBeTruthy();
      expect((await client.listTools()).tools.map(tool => tool.name)).toContain("echo");
      expect((await client.callTool({ name: "echo", arguments: {} })).content).toEqual([{ type: "text", text: "fixture echo" }]);
      expect((await client.listResources()).resources[0].uri).toBe("fixture://readme");
      expect((await client.readResource({ uri: "fixture://readme" })).contents[0]).toMatchObject({ text: "fixture resource" });
      expect((await client.listPrompts()).prompts[0].name).toBe("greet");
      expect((await client.getPrompt({ name: "greet" })).messages[0].content).toMatchObject({ text: "fixture prompt" });
      for (const name of ["task", "input_task"]) {
        expect(await callToolViaTaskSession(taskSession!, { name, args: {} })).toMatchObject({ content: [{ type: "text", text: "task done" }] });
      }
      const abort = new AbortController();
      const pending = callToolViaTaskSession(taskSession!, { name: "pending_task", args: {}, signal: abort.signal });
      // Attach rejection handling before aborting; no unhandled rejection race.
      const rejected = expect(pending).rejects.toThrow();
      await expect.poll(async () => (await f.inspect()).log.some(row => row.method === "tasks/get" && row.params.taskId === "task-3")).toBe(true);
      abort.abort(new Error("cancel fixture task"));
      await rejected;
      await expect.poll(async () => (await f.inspect()).log.some(row => row.method === "tasks/cancel" && row.params.taskId === "task-3")).toBe(true);
      const { log } = await f.inspect();
      expect(log.find(row => row.method === "tasks/update")?.params).toMatchObject({ taskId: "task-2", inputResponses: { roots: { roots: [{ uri: pathToFileURL(process.cwd()).href }] } } });
      for (const row of log.filter(row => row.method.startsWith("tasks/"))) {
        expect(row.params._meta).toMatchObject({ "io.modelcontextprotocol/protocolVersion": "2026-07-28" });
        if (mode === "http") expect(row.headers["mcp-name"]).toBe(row.params.taskId);
      }
    } finally { await f.close(); }
  }, 20000);

  it("routes active/event/heartbeat/terminated by subscriptionId across independent Events sessions", async () => {
    const f = await start(mode);
    const sessionA = createProtocolSession(f.connection, f.owner.signal, EVENTS_PROTOCOL);
    const sessionB = createProtocolSession(f.connection, f.owner.signal, EVENTS_PROTOCOL);
    const receivedA: unknown[] = [], receivedB: unknown[] = [];
    const a = new EventConnection("complete", sessionA, (_sub, event) => receivedA.push(event.data));
    const b = new EventConnection("complete", sessionB, (_sub, event) => receivedB.push(event.data));
    try {
      expect(sessionA.protocolVersion).toBe("2026-07-28");
      expect(sessionA.serverCapabilities).toMatchObject({ extensions: { "io.modelcontextprotocol/tasks": {} } });
      const snapshot = sessionA.serverCapabilities;
      delete snapshot.extensions;
      expect(sessionA.serverCapabilities).toHaveProperty("extensions");
      const subA = await a.subscribe("tick", {});
      const subB = await b.subscribe("tick", {});
      expect(subA.status).toBe("active");
      expect(subB.status).toBe("active");
      expect(subA.id).not.toBe(subB.id);
      await f.connection.client.callTool({ name: "emit", arguments: { subscriptionId: subA.id, value: "a", terminate: true } });
      await expect.poll(() => subA.status).toBe("failed");
      expect(subA.error).toBe("fixture terminated");
      expect(receivedA).toEqual([{ value: "a" }]);
      expect(receivedB).toEqual([]);
      expect(subB.status).toBe("active");
      expect(subA.cursor).toBe("2");
      a.close();
      await f.connection.client.callTool({ name: "emit", arguments: { subscriptionId: subB.id, value: "b" } });
      await expect.poll(() => receivedB).toEqual([{ value: "b" }]);
      await expect.poll(() => subB.cursor).toBe("2");
      expect(sessionB.signal.aborted).toBe(false);
      await b.cancel(subB.id);
      expect(subB.status).toBe("stopped");
      expect(f.connection.activeProtocolOperations).toBe(0);
      const { log } = await f.inspect();
      expect(log.filter(row => row.method === "events/stream").map(row => row.id)).toEqual([subA.id, subB.id]);
    } finally { a.close(); b.close(); await f.close(); }
  }, 20000);

  for (const profile of ["legacy", "unsupported"] as const) it(`${profile}: preserves ordinary tools without attaching unsupported Tasks`, async () => {
    const f = await start(mode, profile);
    try {
      expect(f.connection.taskSession).toBeUndefined();
      expect(f.connection.client.getNegotiatedProtocolVersion()).toBe(profile === "legacy" ? "2025-11-25" : "2026-07-28");
      expect((await f.connection.client.callTool({ name: "echo", arguments: {} })).content).toEqual([{ type: "text", text: "fixture echo" }]);
      if (profile === "unsupported") {
        const session = createProtocolSession(f.connection, f.owner.signal, EVENTS_PROTOCOL);
        await expect(session.request("events/list")).rejects.toThrow(/unsupported/i);
        const stream = session.openStream("events/stream", {}, () => { throw new Error("Unsupported server emitted an event"); });
        await stream.sent;
        expect(await stream.closed).toMatchObject({ reason: "error", protocolError: { code: -32601 } });
        session.close();
      }
      expect((await f.inspect()).log.some(row => row.method.startsWith("tasks/"))).toBe(false);
    } finally { await f.close(); }
  }, 15000);
});
