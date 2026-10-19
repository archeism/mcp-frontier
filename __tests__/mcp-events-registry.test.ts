import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { EventsRegistry } from "../mcp-events-registry.ts";

it("Events registry privately persists session-scoped subscriptions and permits one consumer owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-events-registry-"));
  try {
    const registry = await EventsRegistry.open(root, "pi-session-1");
    await expect(EventsRegistry.open(root, "pi-session-1")).rejects.toThrow("already owned");
    const subscription = { id: "local-sub", server: "fixture", name: "tick", arguments: {}, delivery: "poll" as const,
      status: "active" as const, cursor: "c42", truncated: false };
    await registry.save(subscription);
    expect(registry.list()).toEqual([subscription]);
    await registry.close();
    await expect(EventsRegistry.open(root, "pi-session-2")).rejects.toThrow("another Pi session");
    const restored = await EventsRegistry.open(root, "pi-session-1");
    expect(restored.list()).toEqual([subscription]);
    await restored.save({ ...subscription, status: "stopped" });
    await restored.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(["pin", "subscription"])("a killed Events consumer releases its lease and preserves its inbox pin after %s commit", async phase => {
  const root = await mkdtemp(join(tmpdir(), "mcp-events-registry-crash-"));
  const source = `import {EventsRegistry} from ${JSON.stringify(new URL("../mcp-events-registry.ts", import.meta.url).href)};
const registry=await EventsRegistry.open(process.argv[1],"crash-session");
await registry.pinInboxLocation(process.argv[1]+"/shared");
if(${JSON.stringify(phase)}==="subscription") await registry.save({id:"sub",server:"fixture",name:"tick",arguments:{},delivery:"push",status:"active",cursor:"c42",truncated:false});
process.stdout.write("READY\\n");setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx"), "--input-type=module", "--eval", source, root], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", code => reject(new Error(`Consumer exited before readiness: ${code}`)));
      child.stdout.on("data", data => { if (String(data).includes("READY")) resolve(); });
    });
    await expect(EventsRegistry.open(root, "crash-session")).rejects.toThrow("already owned");
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    const restored = await EventsRegistry.open(root, "crash-session");
    expect(restored.list()).toMatchObject(phase === "subscription" ? [{ id: "sub", status: "active", cursor: "c42" }] : []);
    await mkdir(join(root, "inbox"));
    expect(await restored.pinInboxLocation(join(root, "shared"))).toBe("shared");
    expect(JSON.parse(await readFile(join(root, "subscriptions.json"), "utf8")).inboxLocation).toBe("shared");
    await restored.close();
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
    await rm(root, { recursive: true, force: true });
  }
}, 10000);

it.each(["/arbitrary/path", "../inbox", "", null, 0, {}])("rejects malformed persisted inbox pin without leaking the registry lease: %j", async value => {
  const root = await mkdtemp(join(tmpdir(), "mcp-events-pin-invalid-"));
  try {
    const raw = JSON.stringify({ version: 1, sessionId: "session", inboxLocation: value, entries: [] });
    await writeFile(join(root, "subscriptions.json"), raw);
    await expect(EventsRegistry.open(root, "session")).rejects.toThrow();
    await expect(EventsRegistry.open(root, "session")).rejects.toThrow();
    expect(await readFile(join(root, "subscriptions.json"), "utf8")).toBe(raw);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("pins populated immutable legacy storage and preserves the pin on later subscription writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-events-pin-legacy-"));
  try {
    await mkdir(join(root, "inbox"));
    const legacy = join(root, "inbox", "retained-record.json"); await writeFile(legacy, "retained legacy bytes");
    const registry = await EventsRegistry.open(root, "session");
    expect(await registry.pinInboxLocation(join(root, "shared"))).toBe("session");
    await registry.save({ id: "sub", server: "fixture", name: "tick", arguments: {}, delivery: "poll", status: "active", cursor: null, truncated: false });
    await registry.close();
    const reopened = await EventsRegistry.open(root, "session");
    expect(await reopened.pinInboxLocation(join(root, "shared"))).toBe("session");
    await reopened.close(); expect(await readFile(legacy, "utf8")).toBe("retained legacy bytes");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("serializes concurrent pin/save and fences pinning after close", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-events-pin-fence-"));
  try {
    const registry = await EventsRegistry.open(root, "session");
    const pin = registry.pinInboxLocation(join(root, "shared"));
    const save = registry.save({ id: "sub", server: "fixture", name: "tick", arguments: {}, delivery: "poll", status: "active", cursor: null, truncated: false });
    await Promise.all([pin, save, registry.close()]);
    await expect(registry.pinInboxLocation(join(root, "shared"))).rejects.toThrow("closed");
    const snapshot = JSON.parse(await readFile(join(root, "subscriptions.json"), "utf8"));
    expect(snapshot.inboxLocation).toBe("shared"); expect(snapshot.entries).toHaveLength(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
