import { mkdtemp, rm, open, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fork } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { DurableWebhookInbox } from "../mcp-events-inbox.ts";

vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, open: vi.fn(fs.open) };
});

const event = { eventId: "e1", name: "tick", timestamp: "2026-10-16T14:00:00Z", data: { value: 42 }, cursor: "c1" };
const recordName = createHash("sha256").update(JSON.stringify(["scope", "e1"])).digest("hex") + ".json";
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");

it("atomically bounds retained records across scopes; duplicates and acknowledgements work at capacity", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-inbox-quota-"));
  try {
    const inbox = new DurableWebhookInbox(root, { maxRecords: 1, maxBytes: 4096 });
    expect(await inbox.accept("scope", "e1", event)).toBe(true);
    await expect(new DurableWebhookInbox(root).accept("another-scope", "e1", event)).rejects.toThrow(/capacity/i);
    expect(await inbox.accept("scope", "e1", { ...event, cursor: "c2" })).toBe(false);
    await inbox.acknowledge("scope", "e1");
    expect(await inbox.pending("scope")).toEqual([]);
    expect(await new DurableWebhookInbox(root).accept("scope", "e1", event)).toBe(false);
    await expect(inbox.accept("scope", "e2", { ...event, eventId: "e2" })).rejects.toThrow(/capacity/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("bounds bytes and pending batches without losing the unacknowledged tail", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-inbox-batch-"));
  const firstBytes = Buffer.byteLength(JSON.stringify({ scope: "scope", id: "e1", delivery: event }));
  try {
    const inbox = new DurableWebhookInbox(root, { maxBytes: firstBytes * 3, pendingLimit: 2, pendingBytes: firstBytes * 2, maxRecordBytes: firstBytes * 2 });
    for (let i = 1; i <= 3; i++) await inbox.accept("scope", `e${i}`, { ...event, eventId: `e${i}` });
    expect((await inbox.pending("scope")).map(row => row.id)).toEqual(["e1", "e2"]);
    await inbox.acknowledge("scope", "e1"); await inbox.acknowledge("scope", "e2");
    expect((await inbox.pending("scope")).map(row => row.id)).toEqual(["e3"]);
    await expect(inbox.accept("scope", "e4", { ...event, eventId: "e4" })).rejects.toThrow(/capacity/i);
    expect(await inbox.accept("scope", "e3", { ...event, eventId: "e3" })).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(["records", "bytes"])("real competing processes cannot exceed the same %s quota", async kind => {
  const root = await mkdtemp(join(tmpdir(), "mcp-inbox-quota-process-"));
  const children: ReturnType<typeof fork>[] = [];
  try {
    const bytes = Buffer.byteLength(JSON.stringify({ scope: "scope", id: "e1", delivery: event }));
    const inbox = new DurableWebhookInbox(root, kind === "records" ? { maxRecords: 1 } : { maxBytes: bytes });
    await inbox.pending("scope");
    const launch = async (id: string) => {
      const child = fork(new URL("./fixtures/mcp-events-inbox-child.ts", import.meta.url), [root, "quota", id], {
        execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"],
      }); children.push(child);
      await once(child, "message");
      return { child, run: () => { const result = once(child, "message"); child.send("go"); return result.then(([message]) => message); } };
    };
    const a = await launch("e1"), b = await launch("e2");
    const results = await Promise.all([a.run(), b.run()]);
    expect(results.filter(row => row.created === true)).toHaveLength(1);
    expect(results.filter(row => /capacity/i.test(row.error ?? ""))).toHaveLength(1);
    expect(await inbox.pending("scope")).toHaveLength(1);
    const names = await readdir(root);
    const allocated = await Promise.all(names.map(async name => (await stat(join(root, name))).blocks * 512));
    expect(allocated.reduce((a, b) => a + b, 0)).toBeLessThan(1024 * 1024);
  } finally {
    await Promise.all(children.filter(child => child.exitCode === null && child.signalCode === null).map(async child => {
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    }));
    await rm(root, { recursive: true, force: true });
  }
}, 10000);

it("deduplicates an event with a newer safe watermark, retaining its first body; controls remain strict", async () => {
  // https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/d5316be214be2e76e51462069c1d67e00a5a7619/docs/design-sketch-proposal.md#webhook-event-delivery
  // Pinned Events draft: cursor is a safe-to-persist
  // watermark, not the event position; eventId identifies the occurrence.
  const root = await mkdtemp(join(tmpdir(), "mcp-inbox-watermark-"));
  try {
    const inbox = new DurableWebhookInbox(root);
    expect(await inbox.accept("scope", "e1", event)).toBe(true);
    expect(await inbox.accept("scope", "e1", { ...event, cursor: "c2" })).toBe(false);
    expect(await inbox.accept("scope", "e1", { ...event, cursor: undefined })).toBe(false);
    expect(await inbox.pending("scope")).toEqual([{ id: "e1", delivery: event }]);
    await inbox.acknowledge("scope", "e1");
    expect(await inbox.accept("scope", "e1", { ...event, cursor: "c3" })).toBe(false);
    expect(await inbox.pending("scope")).toEqual([]);
    await expect(inbox.accept("scope", "e1", { ...event, data: { value: 43 } })).rejects.toThrow("different payload");
    await inbox.accept("scope", "msg_gap_1", { type: "gap", cursor: "c1" });
    await expect(inbox.accept("scope", "msg_gap_1", { type: "gap", cursor: "c2" })).rejects.toThrow("different payload");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(["before-commit", "after-commit"])("recovers after SIGKILL at the %s SQLite boundary", async boundary => {
  const root = await mkdtemp(join(tmpdir(), "mcp-inbox-crash-"));
  const maxStorageBytes = 4 * 1024 * 1024;
  await new DurableWebhookInbox(root, { maxStorageBytes }).pending("scope");
  const child = fork(new URL("./fixtures/mcp-events-inbox-child.ts", import.meta.url), [root, boundary], {
    execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  try {
    await once(child, "message");
    const reached = once(child, "message"); child.send("go");
    expect((await reached)[0]).toEqual({ boundary });
    const activeNames = await readdir(root);
    if (boundary === "before-commit") expect(activeNames).toContain("inbox.sqlite-journal");
    const activeBytes = await Promise.all(activeNames.map(async name => (await stat(join(root, name))).blocks * 512));
    expect(activeBytes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(maxStorageBytes);
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    const recovered = new DurableWebhookInbox(root);
    expect(await recovered.pending("scope")).toEqual(boundary === "after-commit" ? [{ id: "e1", delivery: event }] : []);
    expect(await recovered.accept("scope", "e1", event)).toBe(boundary === "before-commit");
    const names = await readdir(root);
    expect(names).toEqual(["inbox.sqlite"]);
    const allocated = await Promise.all(names.map(async name => (await stat(join(root, name))).blocks * 512));
    expect(allocated.reduce((a, b) => a + b, 0)).toBeLessThan(1024 * 1024);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 10000);

it("syncs newly created ancestors before acceptance, including retry after a failed parent sync", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-inbox-sync-"));
  const directory = join(root, "new-parent", "inbox");
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let failures = 0;
  vi.mocked(open).mockImplementation(async (...args: Parameters<typeof open>) => {
    const handle = await actual.open(...args);
    if (args[0] === root && args[1] === "r") {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { if (failures++ === 0) throw new Error("injected parent sync failure"); await sync(); };
    }
    return handle;
  });
  try {
    const inbox = new DurableWebhookInbox(directory);
    await expect(inbox.accept("scope", "e1", event)).rejects.toThrow("injected parent sync failure");
    expect(await inbox.accept("scope", "e1", event)).toBe(false);
    expect(failures).toBe(2);
    expect(await inbox.pending("scope")).toEqual([{ id: "e1", delivery: event }]);
  } finally { vi.mocked(open).mockImplementation(actual.open); await rm(root, { recursive: true, force: true }); }
});

it.each([
  ["unknown.json", "{}"],
  [recordName, JSON.stringify({ scope: "scope", id: "e1", delivery: { type: "unknown" } })],
  [recordName, JSON.stringify({ scope: "other", id: "e1", delivery: event })],
  [recordName, "{"],
  [recordName + ".ack", "accepted by consumer\n"],
])("fails closed on persisted record %s (%s)", async (name, body) => {
  const root = await mkdtemp(join(tmpdir(), "mcp-inbox-invalid-"));
  try {
    await writeFile(join(root, name), body);
    await expect(new DurableWebhookInbox(root).pending("scope")).rejects.toThrow();
    expect(await readFile(join(root, name), "utf8")).toBe(body);
    expect(await readdir(root)).toEqual([name]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("rejects even valid legacy payloads/tombstones without deleting or silently skipping them", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-inbox-legacy-"));
  try {
    const body = JSON.stringify({ scope: "scope", id: "e1", delivery: event });
    await writeFile(join(root, recordName), body); await writeFile(join(root, recordName + ".ack"), "accepted by consumer\n");
    const inbox = new DurableWebhookInbox(root);
    await expect(inbox.pending("scope")).rejects.toThrow(/migration/i);
    await expect(inbox.accept("scope", "e1", event)).rejects.toThrow(/migration/i);
    await expect(inbox.acknowledge("scope", "e1")).rejects.toThrow(/migration/i);
    expect(await readFile(join(root, recordName), "utf8")).toBe(body);
    expect(await readFile(join(root, recordName + ".ack"), "utf8")).toBe("accepted by consumer\n");
    expect((await readdir(root)).sort()).toEqual([recordName, recordName + ".ack"].sort());
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(["unknown-type", "wrong-scope", "malformed-json", "digest"])("fails closed on malformed SQLite payload %s", async kind => {
  const root = await mkdtemp(join(tmpdir(), "mcp-inbox-tamper-"));
  try {
    const inbox = new DurableWebhookInbox(root);
    await inbox.accept("scope", "e1", event);
    const db = new DatabaseSync(join(root, "inbox.sqlite"));
    try {
      const trigger = db.prepare("SELECT sql FROM sqlite_schema WHERE name='inbox_immutable'").get().sql;
      db.exec("DROP TRIGGER inbox_immutable");
      const body = kind === "malformed-json" ? "{" : JSON.stringify({ scope: kind === "wrong-scope" ? "other" : "scope", id: "e1",
        delivery: kind === "unknown-type" ? { type: "unknown" } : event });
      db.prepare("UPDATE inbox_entries SET body=?,bytes=?,digest=?").run(body, Buffer.byteLength(body),
        kind === "digest" ? "0".repeat(64) : createHash("sha256").update(body).digest("hex"));
      db.exec(trigger);
    } finally { db.close(); }
    await expect(inbox.pending("scope")).rejects.toThrow();
    await expect(inbox.accept("scope", "e1", event)).rejects.toThrow();
    await expect(inbox.acknowledge("scope", "e1")).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("uses the pending index, bounds UTF-8 batches, and rejects attempts to bypass durable limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-inbox-index-"));
  try {
    const inbox = new DurableWebhookInbox(root, { maxRecords: 3, pendingLimit: 1 });
    await inbox.accept("scope", "e1", { ...event, data: { text: "中文" } });
    await inbox.accept("scope", "e2", { ...event, eventId: "e2" });
    expect(await inbox.pending("scope")).toHaveLength(1);
    const db = new DatabaseSync(join(root, "inbox.sqlite"));
    try {
      const plan = db.prepare("EXPLAIN QUERY PLAN SELECT scope,id,body,bytes,acknowledged,digest FROM inbox_entries INDEXED BY inbox_pending WHERE scope=? AND acknowledged<>1 ORDER BY seq LIMIT ?").all("scope", 1);
      expect(JSON.stringify(plan)).toContain("USING INDEX inbox_pending");
      expect(JSON.stringify(plan)).not.toContain("TEMP B-TREE");
      expect(() => db.exec("DELETE FROM inbox_entries")).toThrow(/retained/i);
      expect(() => db.exec("UPDATE inbox_entries SET body='{}'")).toThrow(/immutable/i);
    } finally { db.close(); }
    await expect(new DurableWebhookInbox(root, { maxRecords: 4 }).accept("scope", "e3", { ...event, eventId: "e3" })).rejects.toThrow(/limits differ/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("physical capacity refuses new payloads while duplicates and acknowledgements still work", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-inbox-physical-"));
  const maxStorageBytes = 4 * 1024 * 1024;
  try {
    const inbox = new DurableWebhookInbox(root, { maxStorageBytes });
    let accepted = 0;
    for (let i = 0; i < 20; i++) {
      const id = `large-${i}`, delivery = { ...event, eventId: id, data: { text: "x".repeat(250000) } };
      try { await inbox.accept("scope", id, delivery); accepted++; }
      catch (error) { expect(String(error)).toMatch(/capacity/i); break; }
    }
    expect(accepted).toBeGreaterThan(0); expect(accepted).toBeLessThan(20);
    const first = (await inbox.pending("scope"))[0]!;
    expect(await inbox.accept("scope", first.id, first.delivery)).toBe(false);
    await inbox.acknowledge("scope", first.id);
    expect((await inbox.pending("scope")).some(row => row.id === first.id)).toBe(false);
    const names = await readdir(root);
    expect(names).toEqual(["inbox.sqlite"]);
    const allocated = (await stat(join(root, "inbox.sqlite"))).blocks * 512;
    expect(allocated).toBeLessThanOrEqual(maxStorageBytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("does not hide an event behind a malformed SQLite acknowledgement", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-inbox-ack-"));
  try {
    const inbox = new DurableWebhookInbox(root);
    await inbox.accept("scope", "e1", event);
    const db = new DatabaseSync(join(root, "inbox.sqlite"));
    try { db.exec("PRAGMA ignore_check_constraints=ON; UPDATE inbox_entries SET acknowledged=2"); }
    finally { db.close(); }
    await expect(inbox.pending("scope")).rejects.toThrow();
    await expect(inbox.acknowledge("scope", "e1")).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("competing Node processes claim once; SIGKILL restart preserves events, acknowledgements and tombstones", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-inbox-process-"));
  const children: ReturnType<typeof fork>[] = [];
  async function start(action: string) {
    const child = fork(new URL("./fixtures/mcp-events-inbox-child.ts", import.meta.url), [root, action], {
      execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    children.push(child);
    const message = async () => {
      const [value] = await once(child, "message");
      if (value.error) throw new Error(value.error);
      return value;
    };
    await message();
    return { child, run: () => { const reply = message(); child.send("go"); return reply; } };
  }
  async function crash(child: ReturnType<typeof fork>) {
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  }
  try {
    const a = await start("accept"), b = await start("accept");
    expect((await Promise.all([a.run(), b.run()])).map(x => x.created).sort()).toEqual([false, true]);
    await crash(a.child); await crash(b.child);
    const restarted = await start("pending");
    expect((await restarted.run()).pending).toEqual([{ id: "e1", delivery: event }]);
    await crash(restarted.child);
    const ack = await start("ack"); await ack.run(); await crash(ack.child);
    const afterAck = await start("pending"); expect((await afterAck.run()).pending).toEqual([]); await crash(afterAck.child);
    const retry = await start("accept"); expect((await retry.run()).created).toBe(false); await crash(retry.child);
    const names = await readdir(root);
    expect(names).toEqual(["inbox.sqlite"]);
    const allocated = await Promise.all(names.map(async name => (await stat(join(root, name))).blocks * 512));
    expect(allocated.reduce((a, b) => a + b, 0)).toBeLessThan(1024 * 1024);
  } finally {
    await Promise.all(children.filter(child => child.exitCode === null && child.signalCode === null).map(crash));
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

it("webhook acceptance atomically deduplicates concurrent retries and survives receiver restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-webhook-inbox-"));
  const event = { eventId: "e1", name: "tick", timestamp: "2026-10-16T14:00:00Z", data: { value: 42 }, cursor: "c1" };
  try {
    const inbox = new DurableWebhookInbox(root);
    const duplicate = new DurableWebhookInbox(root);
    const accepted = await Promise.all([inbox.accept("session/sub-1", "e1", event), duplicate.accept("session/sub-1", "e1", event)]);
    expect(accepted.sort()).toEqual([false, true]);
    const restored = new DurableWebhookInbox(root);
    expect(await restored.pending("session/sub-1")).toEqual([{ id: "e1", delivery: event }]);
    await restored.acknowledge("session/sub-1", "e1");
    const restarted = new DurableWebhookInbox(root);
    expect(await restarted.pending("session/sub-1")).toEqual([]);
    expect(await restarted.accept("session/sub-1", "e1", event)).toBe(false);
    expect(await restarted.accept("session/sub-2", "e1", event)).toBe(true);
    await expect(restarted.accept("session/sub-1", "e1", { ...event, data: { value: 43 } })).rejects.toThrow("different payload");
  } finally { await rm(root, { recursive: true, force: true }); }
});
