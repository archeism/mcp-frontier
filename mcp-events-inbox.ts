import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readdirSync, statSync } from "node:fs";
import { chmod, mkdir, open, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod/v4";
import type { WebhookDelivery } from "./mcp-events-webhook.ts";

export interface WebhookInboxLimits {
  /** Retained records and UTF-8 entry JSON bytes, INCLUDING acknowledged rows. */
  maxRecords?: number; maxBytes?: number; maxRecordBytes?: number;
  /** Managed database + rollback-journal allowance; no WAL or disk temp files. */
  maxStorageBytes?: number;
  /** Each pending(scope) call returns a bounded, insertion-ordered batch. */
  pendingLimit?: number; pendingBytes?: number;
}
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const limitsSchema = z.object({ maxRecords: positive, maxBytes: positive, maxRecordBytes: positive,
  maxStorageBytes: positive.min(4 * 1024 * 1024) }).strict();
const defaults = { maxRecords: 10000, maxBytes: 32 * 1024 * 1024,
  maxRecordBytes: 512 * 1024, maxStorageBytes: 256 * 1024 * 1024 };
const PAGE = 65536;
const filename = "inbox.sqlite";
const record = z.record(z.string(), z.unknown());
const deliverySchema = z.union([
  z.object({ eventId: z.string().min(1).max(1024), name: z.string().min(1).max(256),
    timestamp: z.iso.datetime({ offset: true }), data: record,
    cursor: z.string().nullable().optional(), _meta: record.optional(),
  }).passthrough().refine(value => !("type" in value)),
  z.object({ type: z.literal("gap"), cursor: z.string().nullable() }).passthrough(),
  z.object({ type: z.literal("terminated"), error: z.object({ code: z.number().int(),
    message: z.string(), data: z.unknown().optional() }).passthrough() }).passthrough(),
]);
const entrySchema = z.object({ scope: z.string().min(1), id: z.string().min(1), delivery: deliverySchema }).strict();
interface Entry { scope: string; id: string; delivery: WebhookDelivery }
const identity = (delivery: WebhookDelivery) => {
  if ("type" in delivery) return delivery;
  // The draft's cursor is a safe watermark, not occurrence identity.
  const { cursor: _cursor, ...occurrence } = delivery;
  return occurrence;
};
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
interface Statement {
  get(...args: (string | number)[]): unknown;
  all(...args: (string | number)[]): unknown[];
  iterate(...args: (string | number)[]): IterableIterator<unknown>;
  run(...args: (string | number)[]): unknown;
}
interface Database { exec(sql: string): void; prepare(sql: string): Statement; close(): void }
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (path: string) => Database };
const schema = [
  `CREATE TABLE inbox_limits (id INTEGER PRIMARY KEY CHECK(id=1), settings TEXT NOT NULL, records_used INTEGER NOT NULL CHECK(records_used>=0), bytes_used INTEGER NOT NULL CHECK(bytes_used>=0)) STRICT`,
  `CREATE TABLE inbox_entries (seq INTEGER PRIMARY KEY, scope TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes>0 AND bytes=length(CAST(body AS BLOB))), acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged IN (0,1)), digest TEXT NOT NULL CHECK(length(digest)=64), UNIQUE(scope,id)) STRICT`,
  `CREATE INDEX inbox_pending ON inbox_entries(scope,seq) WHERE acknowledged<>1`,
  `CREATE TRIGGER inbox_immutable BEFORE UPDATE ON inbox_entries WHEN NEW.seq IS NOT OLD.seq OR NEW.scope IS NOT OLD.scope OR NEW.id IS NOT OLD.id OR NEW.body IS NOT OLD.body OR NEW.bytes IS NOT OLD.bytes OR NEW.digest IS NOT OLD.digest OR NEW.acknowledged<OLD.acknowledged BEGIN SELECT RAISE(ABORT,'Inbox payloads and tombstones are immutable'); END`,
  `CREATE TRIGGER inbox_retain BEFORE DELETE ON inbox_entries BEGIN SELECT RAISE(ABORT,'Inbox payloads and tombstones are retained'); END`,
];
const rowSchema = z.object({ scope: z.string(), id: z.string(), body: z.string(), bytes: positive,
  acknowledged: z.union([z.literal(0), z.literal(1)]), digest: z.string().regex(/^[a-f0-9]{64}$/) });
type Limits = z.infer<typeof limitsSchema>;

/** Bounded, transactional acceptance shared across scopes/processes. Payloads
 * and acknowledged tombstones are retained: hitting capacity stops admission,
 * not recovery or acknowledgement. No payload GC or exactly-once agent claim.
 * Requires local SQLite locking. macOS durability is PROCESS RESTART ONLY,
 * not power-loss durability. Legacy immutable files require explicit migration.
 * maxStorageBytes reserves 4x the DB page cap plus 4 pages for journal/rounding:
 * 64 KiB pages cover SQLite's sector-size ceiling; DELETE journaling, no VACUUM,
 * WAL, disk sorts or payload copies. Filesystem metadata/external files are not
 * included; supported allocation/sector units must be <=64 KiB.
 */
export class DurableWebhookInbox {
  private options: WebhookInboxLimits;
  constructor(readonly directory: string, options: WebhookInboxLimits = {}) {
    this.options = { ...options };
    limitsSchema.parse({ ...defaults, ...this.admissionOptions() });
    positive.parse(options.pendingLimit ?? 100); positive.parse(options.pendingBytes ?? 1024 * 1024);
  }
  private admissionOptions() {
    const { pendingLimit: _limit, pendingBytes: _bytes, ...admission } = this.options;
    return admission;
  }
  private async syncDirectories() {
    // Includes ancestors on every retry after an uncertain directory fsync.
    for (let path = resolve(this.directory);;) {
      const handle = await open(path, "r");
      try { await handle.sync(); } finally { await handle.close(); }
      const parent = dirname(path); if (parent === path) return; path = parent;
    }
  }
  private decode(raw: unknown, limits: Limits): Entry {
    const row = rowSchema.parse(raw);
    if (row.bytes > limits.maxRecordBytes || Buffer.byteLength(row.body) !== row.bytes || digest(row.body) !== row.digest)
      throw new Error("Invalid webhook inbox record");
    const entry = entrySchema.parse(JSON.parse(row.body)) as Entry;
    if (entry.scope !== row.scope || entry.id !== row.id ||
      (!("type" in entry.delivery) && entry.delivery.eventId !== entry.id)) throw new Error("Invalid webhook inbox record identity");
    return entry;
  }
  private async transaction<T>(work: (db: Database, limits: Limits, used: { records: number; bytes: number }) => T): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const names = await readdir(this.directory);
    for (const name of names) {
      if (name !== filename && name !== filename + "-journal")
        throw new Error("Legacy or unknown webhook inbox files require explicit migration; no files were deleted");
    }
    const db = new DatabaseSync(join(this.directory, filename));
    let begun = false;
    let result: T;
    try {
      await chmod(join(this.directory, filename), 0o600);
      db.exec("PRAGMA busy_timeout=2000; PRAGMA page_size=65536; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA temp_store=MEMORY; PRAGMA mmap_size=0; PRAGMA cache_size=-1024; BEGIN IMMEDIATE");
      begun = true;
      const existing = db.prepare("SELECT sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 6").all() as Array<{ sql: string }>;
      let limits: Limits;
      if (!existing.length) {
        limits = limitsSchema.parse({ ...defaults, ...this.admissionOptions() });
      } else {
        if (existing.length !== schema.length || existing.map(row => row.sql).sort().join("\n") !== [...schema].sort().join("\n"))
          throw new Error("Unknown or modified webhook inbox schema");
        const stored = db.prepare("SELECT settings FROM inbox_limits WHERE id=1").get() as { settings: string } | undefined;
        if (!stored) throw new Error("Missing webhook inbox limits");
        limits = limitsSchema.parse(JSON.parse(stored.settings));
        for (const [key, value] of Object.entries(this.admissionOptions()))
          if (value !== undefined && limits[key as keyof Limits] !== value) throw new Error("Webhook inbox admission limits differ from the durable limits");
      }
      if ((this.options.pendingBytes ?? 1024 * 1024) < limits.maxRecordBytes)
        throw new Error("Pending byte budget cannot hold the maximum admitted record");
      const pageSize = db.prepare("PRAGMA page_size").get() as { page_size: number };
      if (pageSize.page_size !== PAGE) throw new Error("Unsupported webhook inbox page size");
      const pages = Math.floor((limits.maxStorageBytes - 4 * PAGE) / (4 * PAGE));
      const cap = db.prepare(`PRAGMA max_page_count=${pages}`).get() as { max_page_count: number };
      if (cap.max_page_count > pages) throw new Error("Webhook inbox capacity exceeded by existing database");
      for (const name of readdirSync(this.directory)) {
        if (name !== filename && name !== filename + "-journal") throw new Error("Unknown webhook inbox file");
        let size;
        try { size = statSync(join(this.directory, name)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (size && size.size > limits.maxStorageBytes / 2) throw new Error("Webhook inbox capacity exceeded by existing storage");
      }
      if (!existing.length) {
        for (const sql of schema) db.exec(sql);
        db.prepare("INSERT INTO inbox_limits VALUES (1,?,0,0)").run(JSON.stringify(limits));
      }
      const meter = db.prepare("SELECT records_used,bytes_used FROM inbox_limits WHERE id=1").get() as { records_used: number; bytes_used: number };
      const used = { records: z.number().int().nonnegative().max(limits.maxRecords).parse(meter.records_used),
        bytes: z.number().int().nonnegative().max(limits.maxBytes).parse(meter.bytes_used) };
      result = work(db, limits, used);
      db.exec("COMMIT"); begun = false;
    } catch (error) {
      if (begun) { try { db.exec("ROLLBACK"); } catch { /* SQLite FULL may already roll back. */ } }
      if (/database or disk is full|SQLITE_FULL/i.test(String(error))) throw new Error("Webhook inbox storage capacity reached");
      throw error;
    } finally { db.close(); }
    await this.syncDirectories();
    return result;
  }
  async accept(scope: string, id: string, delivery: WebhookDelivery): Promise<boolean> {
    const body = JSON.stringify({ scope, id, delivery });
    const entry = entrySchema.parse(JSON.parse(body)) as Entry;
    if (!("type" in entry.delivery) && entry.delivery.eventId !== id) throw new Error("Invalid webhook inbox record identity");
    return this.transaction((db, limits, used) => {
      const previous = db.prepare("SELECT scope,id,body,bytes,acknowledged,digest FROM inbox_entries WHERE scope=? AND id=?").get(scope, id);
      if (previous) {
        if (!isDeepStrictEqual(identity(this.decode(previous, limits).delivery), identity(entry.delivery)))
          throw new Error("Webhook delivery id reused with a different payload");
        return false;
      }
      const bytes = Buffer.byteLength(body);
      if (bytes > limits.maxRecordBytes || used.records >= limits.maxRecords || bytes > limits.maxBytes - used.bytes)
        throw new Error("Webhook inbox admission capacity reached");
      db.prepare("INSERT INTO inbox_entries(scope,id,body,bytes,digest) VALUES (?,?,?,?,?)").run(scope, id, body, bytes, digest(body));
      db.prepare("UPDATE inbox_limits SET records_used=records_used+1,bytes_used=bytes_used+?").run(bytes);
      return true;
    });
  }
  async pending(scope: string): Promise<Array<{ id: string; delivery: WebhookDelivery }>> {
    if (!scope) throw new Error("Subscription scope is required");
    return this.transaction((db, limits) => {
      const result: Array<{ id: string; delivery: WebhookDelivery }> = [];
      let bytes = 0;
      const rows = db.prepare("SELECT scope,id,body,bytes,acknowledged,digest FROM inbox_entries INDEXED BY inbox_pending WHERE scope=? AND acknowledged<>1 ORDER BY seq LIMIT ?")
        .iterate(scope, this.options.pendingLimit ?? 100);
      for (const raw of rows) {
        const entry = this.decode(raw, limits), size = (raw as { bytes: number }).bytes;
        if (size > (this.options.pendingBytes ?? 1024 * 1024) - bytes) break;
        result.push({ id: entry.id, delivery: entry.delivery }); bytes += size;
      }
      return result;
    });
  }
  async acknowledge(scope: string, id: string): Promise<void> {
    if (!scope || !id) throw new Error("Subscription scope and delivery id are required");
    await this.transaction((db, limits) => {
      const row = db.prepare("SELECT scope,id,body,bytes,acknowledged,digest FROM inbox_entries WHERE scope=? AND id=?").get(scope, id);
      if (!row) throw new Error("Cannot acknowledge an unaccepted webhook delivery");
      this.decode(row, limits);
      // 0->1 has constant-size integer encoding, removes the pending index
      // entry, and never adds a payload/tombstone row at capacity.
      db.prepare("UPDATE inbox_entries SET acknowledged=1 WHERE scope=? AND id=? AND acknowledged=0").run(scope, id);
    });
  }
}
