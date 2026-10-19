import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { chmodSync, mkdirSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod/v4";
import { toJsonValue } from "@modelcontextprotocol/ext-tasks/core";
import { CreateMessageResultV2Schema, ElicitResultV2Schema, ListRootsResultV2Schema, UpdateTaskResultV2Schema } from "@modelcontextprotocol/ext-tasks/core/v2";
import { stableStringify } from "./utils.js";
import { abortable } from "./abort.js";
const jsonRecord = z.record(z.string(), z.json());
const recordSchema = z.object({
    revision: z.number().int().positive(), endpointId: z.string().min(1), name: z.string().min(1),
    argumentsHash: z.string().regex(/^[0-9a-f]{64}$/), phase: z.enum(["intent", "task", "completed"]),
    reference: z.object({ endpointId: z.string().min(1), generation: z.enum(["v1", "v2"]),
        taskId: z.string().min(1), originalOperation: z.literal("tools/call") }).optional(),
    declaration: z.object({ name: z.string().min(1), inputSchema: jsonRecord,
        outputSchema: jsonRecord.optional() }).passthrough().optional(),
    result: jsonRecord.optional(), inputs: z.record(z.string(), z.object({
        fingerprint: z.string().regex(/^[0-9a-f]{64}$/), state: z.enum(["started", "ready", "acknowledged"]),
        response: z.json().optional(),
    })),
}).superRefine((record, ctx) => {
    if ((record.phase === "task" && !record.reference) || (record.phase === "completed" && !record.result) ||
        (record.reference && record.reference.endpointId !== record.endpointId) ||
        (record.declaration && record.declaration.name !== record.name) ||
        Object.values(record.inputs).some(input => input.state !== "started" && input.response === undefined))
        ctx.addIssue({ code: "custom", message: "Inconsistent task recovery record" });
});
export const DEFAULT_TASK_RECOVERY_BUDGET = Object.freeze({
    maxRows: 1024, maxBytes: 64 * 1024 * 1024, maxRecordBytes: 1024 * 1024,
});
/** No GC: uncertain/active intents retain full reservations; completed records
 * retain immutable intent/result/tombstone bytes (minimum 512), not unused capacity.
 * The default row ceiling is 1024 retained lifetime intents, not 64 calls.
 * Physical bounds for this store's SQLite files:
 * database <= floor((2*maxBytes + 8192*maxRows + 65536)/pageSize)*pageSize;
 * one DELETE rollback journal <= 2*databaseLimit + 65536 bytes (page images,
 * record/sector headers). No WAL, savepoints, disk temp tables or vacuum copies.
 * An update needs at most one rollback journal; reservation guarantees logical
 * admission capacity, not free space against unrelated writers or disk failure.
 * Existing oversized legacy rows are preserved/reserved; new admission fails
 * if they consume the budget. An already oversized database requires an explicit
 * larger policy; opening never deletes or vacuums recovery evidence.
 */
export class FileTaskRecoveryStore {
    database;
    scope;
    budget;
    constructor(scope, options = {}) {
        if (!scope.sessionId || !isAbsolute(scope.sessionFile))
            throw new Error("Task recovery requires an absolute Pi session file and session ID");
        scope.signal?.throwIfAborted();
        this.scope = { ...scope };
        this.budget = { maxRows: options.maxRows ?? DEFAULT_TASK_RECOVERY_BUDGET.maxRows,
            maxBytes: options.maxBytes ?? DEFAULT_TASK_RECOVERY_BUDGET.maxBytes,
            maxRecordBytes: options.maxRecordBytes ?? DEFAULT_TASK_RECOVERY_BUDGET.maxRecordBytes };
        if (Object.values(this.budget).some(value => !Number.isSafeInteger(value) || value < 1) ||
            this.budget.maxRecordBytes < 512 || this.budget.maxRecordBytes > this.budget.maxBytes)
            throw new Error("Invalid task recovery budget policy (record reservation must be at least 512 bytes)");
        const databaseLimit = this.budget.maxBytes * 2 + this.budget.maxRows * 8192 + 65536;
        if (!Number.isSafeInteger(databaseLimit) || databaseLimit > 4096 * 0xfffffffe)
            throw new Error("Task recovery database budget is too large");
        const directory = options.directory ?? scope.sessionFile + ".mcp-tasks";
        if (!isAbsolute(directory))
            throw new Error("Task recovery directory must be absolute");
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const path = directory + "/recovery.sqlite";
        const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
        this.database = new DatabaseSync(path);
        try {
            chmodSync(path, 0o600);
            this.database.exec("PRAGMA busy_timeout=2000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA temp_store=MEMORY; CREATE TABLE IF NOT EXISTS tasks (session_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(session_id, tool_call_id))");
            this.database.exec("BEGIN IMMEDIATE");
            try {
                this.database.exec("CREATE TABLE IF NOT EXISTS task_budget_policy (id INTEGER PRIMARY KEY CHECK(id=1), policy TEXT NOT NULL); CREATE TABLE IF NOT EXISTS task_capacity (session_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, reserved_bytes INTEGER NOT NULL, PRIMARY KEY(session_id,tool_call_id))");
                const policy = JSON.stringify(this.budget);
                const existing = this.database.prepare("SELECT policy FROM task_budget_policy WHERE id=1").get();
                if (existing && existing.policy !== policy)
                    throw new Error("Task recovery budget policy differs from the shared database");
                if (!existing)
                    this.database.prepare("INSERT INTO task_budget_policy(id,policy) VALUES(1,?)").run(policy);
                // Adopt pre-budget rows without deleting/rewriting their uncertain state.
                this.database.prepare("INSERT OR IGNORE INTO task_capacity SELECT session_id,tool_call_id,MAX(?,length(CAST(record AS BLOB))+length(CAST(session_id AS BLOB))+length(CAST(tool_call_id AS BLOB))) FROM tasks")
                    .run(this.budget.maxRecordBytes);
                // Also release unused reservations from the previous store version.
                this.database.exec("UPDATE task_capacity SET reserved_bytes=(SELECT MAX(512,length(CAST(record AS BLOB))+length(CAST(tasks.session_id AS BLOB))+length(CAST(tasks.tool_call_id AS BLOB))) FROM tasks WHERE tasks.session_id=task_capacity.session_id AND tasks.tool_call_id=task_capacity.tool_call_id) WHERE EXISTS(SELECT 1 FROM tasks WHERE tasks.session_id=task_capacity.session_id AND tasks.tool_call_id=task_capacity.tool_call_id AND json_extract(record,'$.phase')='completed')");
                const { page_size: pageSize } = this.database.prepare("PRAGMA page_size").get();
                const pages = Math.floor(databaseLimit / pageSize);
                const { max_page_count: actual } = this.database.prepare(`PRAGMA max_page_count=${pages}`).get();
                if (actual > pages)
                    throw new Error("Existing task recovery database exceeds physical budget; preserve it and configure a larger policy");
                this.database.exec("COMMIT");
            }
            catch (error) {
                try {
                    this.database.exec("ROLLBACK");
                }
                catch { /* SQLite may already have rolled back (e.g. SQLITE_FULL). */ }
                throw error;
            }
        }
        catch (error) {
            this.database.close();
            throw error;
        }
    }
    async read(toolCallId) {
        this.scope.signal?.throwIfAborted();
        return this.readSync(toolCallId);
    }
    readSync(toolCallId) {
        const row = this.database.prepare("SELECT record FROM tasks WHERE session_id=? AND tool_call_id=?")
            .get(this.scope.sessionId, toolCallId);
        return row ? recordSchema.parse(JSON.parse(row.record)) : undefined;
    }
    async compareAndSet(toolCallId, expectedRevision, next) {
        this.scope.signal?.throwIfAborted();
        if (!toolCallId || next.revision !== (expectedRevision ?? 0) + 1)
            throw new Error("Invalid task recovery revision");
        const encoded = JSON.stringify(recordSchema.parse(toJsonValue(next)));
        this.database.exec("BEGIN IMMEDIATE");
        try {
            const current = this.readSync(toolCallId);
            if (current?.revision !== expectedRevision) {
                this.database.exec("ROLLBACK");
                return false;
            }
            if (current?.phase === "completed")
                throw new Error("Completed task recovery records are immutable");
            this.scope.signal?.throwIfAborted();
            const bytes = Buffer.byteLength(encoded) + Buffer.byteLength(this.scope.sessionId) + Buffer.byteLength(toolCallId);
            const capacity = this.database.prepare("SELECT reserved_bytes FROM task_capacity WHERE session_id=? AND tool_call_id=?")
                .get(this.scope.sessionId, toolCallId);
            if (bytes > (capacity?.reserved_bytes ?? this.budget.maxRecordBytes))
                throw new Error("Task recovery record exceeds reserved byte budget");
            if (!current) {
                const usage = this.database.prepare("SELECT COUNT(*) AS rows,COALESCE(SUM(reserved_bytes),0) AS bytes FROM task_capacity").get();
                if (usage.rows >= this.budget.maxRows || usage.bytes + this.budget.maxRecordBytes > this.budget.maxBytes)
                    throw new Error("Task recovery admission budget exhausted; existing intents are preserved");
                this.database.prepare("INSERT INTO task_capacity(session_id,tool_call_id,reserved_bytes) VALUES(?,?,?)")
                    .run(this.scope.sessionId, toolCallId, this.budget.maxRecordBytes);
            }
            this.database.prepare("INSERT INTO tasks(session_id,tool_call_id,record) VALUES (?,?,?) ON CONFLICT(session_id,tool_call_id) DO UPDATE SET record=excluded.record")
                .run(this.scope.sessionId, toolCallId, encoded);
            if (next.phase === "completed")
                this.database.prepare("UPDATE task_capacity SET reserved_bytes=? WHERE session_id=? AND tool_call_id=?")
                    .run(Math.max(512, bytes), this.scope.sessionId, toolCallId);
            this.database.exec("COMMIT");
            return true;
        }
        catch (error) {
            try {
                this.database.exec("ROLLBACK");
            }
            catch { /* Preserve the primary error after SQLite's automatic rollback. */ }
            throw error;
        }
    }
    close() { this.database.close(); }
}
export function taskRecoveryFingerprint(value) {
    return createHash("sha256").update(stableStringify(toJsonValue(value))).digest("hex");
}
export class TaskRecoveryBinding {
    store;
    calls = new Map();
    waiting = new Map();
    constructor(store) {
        this.store = store;
    }
    key(endpointId, taskId) { return JSON.stringify([endpointId, taskId]); }
    register(reference, call) {
        const key = this.key(reference.endpointId, reference.taskId);
        this.calls.set(key, call);
        this.waiting.get(key)?.resolve(call);
        this.waiting.delete(key);
        return () => { if (this.calls.get(key) === call)
            this.calls.delete(key); };
    }
    async input(endpointId, taskId, inputId, request, signal, invoke) {
        const key = this.key(endpointId, taskId);
        let call = this.calls.get(key);
        if (!call) {
            let waiter = this.waiting.get(key);
            if (!waiter) {
                let resolve;
                const promise = new Promise(accept => { resolve = accept; });
                waiter = { promise, resolve, users: 0 };
                this.waiting.set(key, waiter);
            }
            waiter.users++;
            try {
                call = await abortable(waiter.promise, signal);
            }
            finally {
                waiter.users--;
                if (waiter.users === 0 && this.waiting.get(key) === waiter)
                    this.waiting.delete(key);
            }
        }
        try {
            const fingerprint = taskRecoveryFingerprint(request), old = call.record().inputs[inputId];
            if (old) {
                if (old.fingerprint !== fingerprint)
                    throw new Error("Task input key was reused with different content");
                if (old.state === "started")
                    throw new Error("Task input outcome is unknown; refusing to repeat approval or model work");
                return structuredClone(old.response);
            }
            await call.update(record => ({ ...record, inputs: { ...record.inputs, [inputId]: { fingerprint, state: "started" } } }));
            const result = await invoke();
            const schema = request.kind === "sampling" ? CreateMessageResultV2Schema : request.kind === "roots" ? ListRootsResultV2Schema : ElicitResultV2Schema;
            const response = toJsonValue(schema.parse(toJsonValue(result)));
            await call.update(record => ({ ...record, inputs: { ...record.inputs, [inputId]: { fingerprint, state: "ready", response } } }));
            return result;
        }
        catch (error) {
            // SDK handlers can convert thrown elicitation errors into a cancel response.
            // Abort this local execution first so an uncertain input sends no response.
            call.controller.abort(error);
            throw error;
        }
    }
    dispatch(endpointId, send) {
        return async (request, options) => {
            if (!request || typeof request !== "object" || Array.isArray(request))
                return send(request, options);
            const envelope = request;
            if (envelope.method !== "tasks/update")
                return send(request, options);
            const params = envelope.params, taskId = params.taskId;
            const call = typeof taskId === "string" ? this.calls.get(this.key(endpointId, taskId)) : undefined;
            if (!call)
                return send(request, options);
            const inputs = params.inputResponses;
            const pending = Object.fromEntries(Object.entries(inputs).filter(([id]) => call.record().inputs[id]?.state !== "acknowledged"));
            if (!Object.keys(pending).length)
                return { kind: "result", result: { resultType: "complete" } };
            const result = await send({ ...request, params: { ...params, inputResponses: pending } }, options);
            if (result.kind === "result" && UpdateTaskResultV2Schema.safeParse(result.result).success) {
                try {
                    await call.update(record => ({ ...record, inputs: Object.fromEntries(Object.entries(record.inputs)
                            .map(([id, value]) => [id, Object.hasOwn(pending, id) ? { ...value, state: "acknowledged" } : value])) }));
                }
                catch (error) {
                    call.controller.abort(error);
                    throw error;
                }
            }
            return result;
        };
    }
}
//# sourceMappingURL=task-recovery-store.js.map