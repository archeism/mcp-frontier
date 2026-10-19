import { type JsonValue } from "@modelcontextprotocol/ext-tasks/core";
import type { ApplicationInputRequest, RawClientDispatch, SerializedTaskReference, ToolDeclaration } from "@modelcontextprotocol/ext-tasks/client";
export interface TaskRecoveryScope {
    readonly sessionId: string;
    readonly sessionFile: string;
    readonly signal?: AbortSignal;
}
export interface TaskRecoveryRecord {
    revision: number;
    endpointId: string;
    name: string;
    argumentsHash: string;
    phase: "intent" | "task" | "completed";
    reference?: SerializedTaskReference;
    declaration?: ToolDeclaration;
    result?: Record<string, unknown>;
    inputs: Record<string, {
        fingerprint: string;
        state: "started" | "ready" | "acknowledged";
        response?: JsonValue;
    }>;
}
/** Each store is bound to one actual Pi session, never a mutable current-session pointer. */
export interface TaskRecoveryStore {
    read(toolCallId: string): Promise<TaskRecoveryRecord | undefined>;
    compareAndSet(toolCallId: string, expectedRevision: number | undefined, next: TaskRecoveryRecord): Promise<boolean>;
}
export interface FileTaskRecoveryStoreOptions {
    /** One operator-private directory can aggregate all Pi sessions in one database.
     * Omission preserves the historical <sessionFile>.mcp-tasks directory. */
    directory?: string;
    maxRows?: number;
    /** Aggregate reserved capacity, not just the current JSON byte count. */
    maxBytes?: number;
    /** Reserved at admission for this intent's reference, input ledger and result. */
    maxRecordBytes?: number;
}
export declare const DEFAULT_TASK_RECOVERY_BUDGET: Readonly<{
    maxRows: number;
    maxBytes: number;
    maxRecordBytes: number;
}>;
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
export declare class FileTaskRecoveryStore implements TaskRecoveryStore {
    private readonly database;
    private readonly scope;
    private readonly budget;
    constructor(scope: TaskRecoveryScope, options?: FileTaskRecoveryStoreOptions);
    read(toolCallId: string): Promise<TaskRecoveryRecord | undefined>;
    private readSync;
    compareAndSet(toolCallId: string, expectedRevision: number | undefined, next: TaskRecoveryRecord): Promise<boolean>;
    close(): void;
}
export declare function taskRecoveryFingerprint(value: unknown): string;
/** Optional per-session binding passed to both attachment and production tool execution. */
export interface TaskRecoveryCall {
    record(): TaskRecoveryRecord;
    update(change: (record: TaskRecoveryRecord) => TaskRecoveryRecord): Promise<void>;
    readonly controller: AbortController;
}
export declare class TaskRecoveryBinding {
    readonly store: TaskRecoveryStore;
    private readonly calls;
    private readonly waiting;
    constructor(store: TaskRecoveryStore);
    private key;
    register(reference: SerializedTaskReference, call: TaskRecoveryCall): () => void;
    input<T>(endpointId: string, taskId: string, inputId: string, request: ApplicationInputRequest, signal: AbortSignal | undefined, invoke: () => Promise<T>): Promise<T>;
    dispatch(endpointId: string, send: RawClientDispatch): RawClientDispatch;
}
