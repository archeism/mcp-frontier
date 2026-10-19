import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { expect, it, vi } from "vitest";
import { FileTaskRecoveryStore, TaskRecoveryBinding, type TaskRecoveryRecord } from "../task-recovery-store.ts";
import { callToolViaTaskSession } from "../mcp-tasks.ts";

const intent = (): TaskRecoveryRecord => ({ revision: 1, endpointId: "endpoint", name: "work",
  argumentsHash: "a".repeat(64), phase: "intent", inputs: {} });
const options = (directory: string) => ({ directory, maxRows: 2, maxBytes: 8192, maxRecordBytes: 4096 });
const scope = (root: string, sessionId = "a") => ({ sessionId, sessionFile: join(root, `${sessionId}.jsonl`) });

it("preserves SQLITE_FULL after automatic CAS rollback, including the durable reference and reservation", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-budget-full-"));
  const policy = { directory: root, maxRows: 2, maxBytes: 2097152, maxRecordBytes: 1048576 };
  let store = new FileTaskRecoveryStore(scope(root), policy);
  const known: TaskRecoveryRecord = { ...intent(), revision: 2, phase: "task", reference: {
    endpointId: "endpoint", generation: "v2", taskId: "durable-remote", originalOperation: "tools/call",
  } };
  try {
    await store.compareAndSet("known", undefined, intent());
    await store.compareAndSet("known", 1, known);
    // Lower only this real connection's physical ceiling to inject SQLITE_FULL;
    // the attempted result is still within its logical reserved byte budget.
    const database = (store as unknown as { database: {
      exec(sql: string): void; prepare(sql: string): { get(): unknown };
    } }).database;
    const usage = () => database.prepare("SELECT COUNT(*) AS rows,SUM(reserved_bytes) AS bytes FROM task_capacity").get();
    const before = usage();
    const { page_count: pages } = database.prepare("PRAGMA page_count").get() as { page_count: number };
    database.exec(`PRAGMA max_page_count=${pages}`);
    const failure = await store.compareAndSet("known", 2, { ...known, revision: 3, phase: "completed", result: { text: "x".repeat(500000) } })
      .catch(error => error);
    expect(await store.read("known")).toEqual(known);
    expect(usage()).toEqual(before);
    store.close(); store = new FileTaskRecoveryStore(scope(root), policy);
    expect(await store.read("known")).toEqual(known);
    expect(failure).toMatchObject({ errcode: 13 });
    expect(failure.message).toMatch(/full/i);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

it("preserves constructor SQLITE_FULL without losing a legacy durable reference", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-budget-init-full-"));
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const known = { ...intent(), phase: "task", reference: {
    endpointId: "endpoint", generation: "v2", taskId: "durable-remote", originalOperation: "tools/call",
  } };
  const old = new DatabaseSync(join(root, "recovery.sqlite"));
  old.exec("CREATE TABLE tasks(session_id TEXT NOT NULL,tool_call_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(session_id,tool_call_id))");
  old.prepare("INSERT INTO tasks VALUES(?,?,?)").run("a", "known", JSON.stringify(known)); old.close();
  const original = DatabaseSync.prototype.exec;
  const hook = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(this: any, sql: string) {
    if (sql.startsWith("CREATE TABLE IF NOT EXISTS task_budget_policy")) {
      const { page_count: pages } = this.prepare("PRAGMA page_count").get();
      original.call(this, `PRAGMA max_page_count=${pages}`);
    }
    return original.call(this, sql);
  });
  let failure: any;
  try {
    try { new FileTaskRecoveryStore(scope(root), options(root)); } catch (error) { failure = error; }
  } finally { hook.mockRestore(); }
  try {
    const store = new FileTaskRecoveryStore(scope(root), options(root));
    try { expect(await store.read("known")).toEqual(known); }
    finally { store.close(); }
    expect(failure).toMatchObject({ errcode: 13 });
    expect(failure.message).toMatch(/full/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("does not admit a reservation smaller than the terminal accounting floor", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-budget-floor-"));
  try {
    expect(() => new FileTaskRecoveryStore(scope(root), { directory: root, maxBytes: 512, maxRecordBytes: 256 }))
      .toThrow(/budget/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("releases only unused terminal capacity, retaining immutable results and full unknown/active reservations", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-budget-terminal-"));
  const policy = { ...options(root), maxRows: 10, maxBytes: 8192 };
  const a = new FileTaskRecoveryStore(scope(root), policy), b = new FileTaskRecoveryStore(scope(root, "b"), policy);
  const completed = { ...intent(), revision: 2, phase: "completed" as const, result: { content: [{ type: "text", text: "done" }] } };
  try {
    await a.compareAndSet("unknown", undefined, intent());
    await a.compareAndSet("first", undefined, intent());
    await expect(b.compareAndSet("blocked", undefined, intent())).rejects.toThrow(/budget/i);
    await a.compareAndSet("first", 1, completed);
    // The unknown record still owns 4096 bytes. The terminal record owns actual
    // encoded bytes (minimum 512), leaving less than another full reservation.
    await expect(b.compareAndSet("still-blocked", undefined, intent())).rejects.toThrow(/budget/i);
    await a.compareAndSet("unknown", 1, completed);
    expect(await b.compareAndSet("admitted", undefined, intent())).toBe(true);
    await expect(a.compareAndSet("first", 2, { ...completed, revision: 3, result: { text: "changed" } })).rejects.toThrow(/immutable|terminal/i);
    expect(await a.read("first")).toEqual(completed);
    expect(await a.read("unknown")).toEqual(completed);
  } finally { a.close(); b.close(); await rm(root, { recursive: true, force: true }); }
});

it("tiny completed calls no longer exhaust the default byte budget at 64 lifetime calls; the row ceiling remains", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-budget-lifetime-"));
  const store = new FileTaskRecoveryStore(scope(root), { directory: root, maxRows: 70 });
  try {
    for (let i = 0; i < 70; i++) {
      await store.compareAndSet(String(i), undefined, intent());
      await store.compareAndSet(String(i), 1, { ...intent(), revision: 2, phase: "completed", result: { text: "done" } });
    }
    await expect(store.compareAndSet("row-limit", undefined, intent())).rejects.toThrow(/budget/i);
    expect(await store.read("0")).toMatchObject({ phase: "completed", result: { text: "done" } });
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

it("bounds aggregate admission across sessions while reserved handle/input/terminal updates remain usable", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-budget-"));
  const a = new FileTaskRecoveryStore(scope(root), options(root));
  const b = new FileTaskRecoveryStore(scope(root, "b"), options(root));
  try {
    expect(await a.compareAndSet("same-id", undefined, intent())).toBe(true);
    expect(await b.compareAndSet("same-id", undefined, intent())).toBe(true);
    await expect(a.compareAndSet("new", undefined, intent())).rejects.toThrow(/budget/i);
    expect(await a.read("new")).toBeUndefined();
    const reference = { endpointId: "endpoint", generation: "v2" as const, taskId: "durable", originalOperation: "tools/call" as const };
    expect(await a.compareAndSet("same-id", 1, { ...intent(), revision: 2, phase: "task", reference })).toBe(true);
    expect(await a.compareAndSet("same-id", 2, { ...intent(), revision: 3, phase: "task", reference,
      inputs: { approval: { fingerprint: "b".repeat(64), state: "acknowledged", response: { action: "accept" } } } })).toBe(true);
    expect(await a.compareAndSet("same-id", 3, { ...intent(), revision: 4, phase: "completed", reference,
      result: { content: [{ type: "text", text: "x".repeat(2800) }] } })).toBe(true);
    expect(await b.read("same-id")).toMatchObject({ phase: "intent", revision: 1 });
    await expect(b.compareAndSet("still-full", undefined, intent())).rejects.toThrow(/budget/i);
  } finally { a.close(); b.close(); await rm(root, { recursive: true, force: true }); }
});

it("reserves aggregate bytes before effects and rejects oversized updates without losing uncertain records", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-budget-"));
  const store = new FileTaskRecoveryStore(scope(root), { ...options(root), maxRows: 20, maxBytes: 4096 });
  try {
    await store.compareAndSet("existing", undefined, intent());
    let invocations = 0;
    const session = { endpointId: "endpoint", async callTool() { invocations++; throw new Error("Remote effect must not start"); } };
    await expect(callToolViaTaskSession(session as never, { name: "work", args: {},
      meta: { "pi-mcp-adapter/toolCallId": "blocked" }, recovery: new TaskRecoveryBinding(store) })).rejects.toThrow(/budget/i);
    expect(invocations).toBe(0);
    await expect(store.compareAndSet("existing", 1, { ...intent(), revision: 2, phase: "completed",
      result: { text: "x".repeat(4096) } })).rejects.toThrow(/budget/i);
    expect(await store.read("existing")).toEqual(intent());
    expect(await store.read("blocked")).toBeUndefined();
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

it("preserves the default per-session directory and rejects a conflicting shared policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-budget-"));
  const legacy = new FileTaskRecoveryStore(scope(root));
  const shared = new FileTaskRecoveryStore(scope(root, "b"), options(root));
  try {
    await legacy.compareAndSet("old", undefined, intent());
    expect((await stat(join(root, "a.jsonl.mcp-tasks", "recovery.sqlite"))).size).toBeGreaterThan(0);
    expect(() => new FileTaskRecoveryStore(scope(root, "c"), { ...options(root), maxRows: 3 })).toThrow(/budget.*policy|policy.*budget/i);
    expect(await legacy.read("old")).toEqual(intent());
  } finally { legacy.close(); shared.close(); await rm(root, { recursive: true, force: true }); }
});

it.each(["rows", "bytes"] as const)("atomically admits at most the shared %s ceiling across independent processes and bounds database/journal growth", async ceiling => {
  const root = await mkdtemp(join(tmpdir(), "task-budget-process-"));
  const policy = { ...options(root), ...(ceiling === "bytes" ? { maxRows: 20 } : { maxBytes: 81920 }) };
  const bootstrap = new FileTaskRecoveryStore(scope(root), policy); bootstrap.close();
  const script = `
    import { FileTaskRecoveryStore } from ${JSON.stringify(new URL("../task-recovery-store.ts", import.meta.url).href)};
    import { DatabaseSync } from "node:sqlite";
    import { statSync } from "node:fs";
    const original = DatabaseSync.prototype.exec; let journalBytes = 0;
    DatabaseSync.prototype.exec = function(sql) {
      if (sql === "COMMIT") { try { journalBytes = Math.max(journalBytes, statSync(${JSON.stringify(join(root, "recovery.sqlite-journal"))}).size); } catch {} }
      return original.call(this, sql);
    };
    const store = new FileTaskRecoveryStore(JSON.parse(process.argv[1]), ${JSON.stringify(policy)});
    process.send({ ready: true });
    process.once("message", async () => {
      let admitted = false;
      try {
        admitted = await store.compareAndSet("child", undefined, ${JSON.stringify(intent())});
        if (admitted) {
          await store.compareAndSet("child", 1, { ...${JSON.stringify(intent())}, revision: 2, phase: "completed", result: { text: "x".repeat(2800) } });
        }
      } catch (error) { if (!/budget/.test(String(error))) throw error; }
      store.close(); process.send({ admitted, journalBytes }); process.disconnect();
    });`;
  const children = Array.from({ length: 6 }, (_, index) => spawn(process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script, JSON.stringify(scope(root, `process-${index}`))],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] }));
  try {
    const workers = children.map(child => {
      let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
      let ready!: () => void, done!: (value: any) => void;
      const started = new Promise<void>(resolve => { ready = resolve; });
      const result = new Promise<any>((resolve, reject) => {
        done = resolve;
        child.on("error", reject); child.on("exit", code => { if (code) reject(new Error(stderr)); });
      });
      child.on("message", (message: any) => { if (message.ready) ready(); else done(message); });
      return { started, result };
    });
    await Promise.all(workers.map(worker => worker.started));
    children.forEach(child => child.send("admit"));
    const results = await Promise.all(workers.map(worker => worker.result));
    expect(results.filter(row => row.admitted)).toHaveLength(2);
    const databaseBytes = (await stat(join(root, "recovery.sqlite"))).size;
    const maxDatabaseBytes = policy.maxBytes * 2 + policy.maxRows * 8192 + 65536;
    expect(databaseBytes).toBeLessThanOrEqual(maxDatabaseBytes);
    expect(Math.max(...results.map(row => row.journalBytes))).toBeGreaterThan(0);
    expect(Math.max(...results.map(row => row.journalBytes))).toBeLessThanOrEqual(maxDatabaseBytes * 2 + 65536);
    const reopen = new FileTaskRecoveryStore(scope(root, "process-0"), policy);
    try { await expect(reopen.compareAndSet("another", undefined, intent())).rejects.toThrow(/budget/i); }
    finally { reopen.close(); }
  } finally {
    children.forEach(child => { if (child.exitCode === null) child.kill(); });
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

it("adopts pre-budget uncertain rows without GC and reserves their future updates", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-budget-adopt-"));
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const old = new DatabaseSync(join(root, "recovery.sqlite"));
  old.exec("CREATE TABLE tasks(session_id TEXT NOT NULL,tool_call_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(session_id,tool_call_id))");
  old.prepare("INSERT INTO tasks VALUES(?,?,?)").run("a", "unknown", JSON.stringify(intent())); old.close();
  const store = new FileTaskRecoveryStore(scope(root), { ...options(root), maxRows: 1 });
  try {
    expect(await store.read("unknown")).toEqual(intent());
    await expect(store.compareAndSet("new", undefined, intent())).rejects.toThrow(/budget/i);
    expect(await store.compareAndSet("unknown", 1, { ...intent(), revision: 2, phase: "task", reference: {
      endpointId: "endpoint", generation: "v2", taskId: "known-later", originalOperation: "tools/call",
    } })).toBe(true);
    expect(await store.read("unknown")).toMatchObject({ reference: { taskId: "known-later" } });
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
