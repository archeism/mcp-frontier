import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";

const subscription = z.object({ id: z.string().min(1), server: z.string().min(1), name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()), delivery: z.enum(["poll", "push", "webhook"]),
  status: z.enum(["opening", "active", "reconnecting", "stopped", "failed"]),
  cursor: z.string().nullable(), truncated: z.boolean(), maxAgeMs: z.number().int().nonnegative().optional(),
  driverState: z.record(z.string(), z.unknown()).optional() });
export type StoredEventSubscription = z.infer<typeof subscription>;
const inboxLocation = z.enum(["shared", "session"]);
type InboxLocation = z.infer<typeof inboxLocation>;
const snapshot = z.object({ version: z.literal(1), sessionId: z.string().min(1), inboxLocation: inboxLocation.optional(), entries: z.array(subscription).max(100) });
const code = (error: unknown) => (error as NodeJS.ErrnoException).code;
// Node >=22.19 and Bun provide this native module; the project's Node 20 type
// package predates it, so describe only the public operations used for the lease.
interface NativeLease { exec(sql: string): void; prepare(sql: string): { get(...args: (string | number)[]): unknown }; close(): void }
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (path: string, options?: { readOnly: boolean }) => NativeLease };

/** Private session registry and single-consumer lease. fsync establishes process
 * restart persistence; it does not claim hardware power-loss guarantees on macOS. */
export class EventsRegistry {
  private entries = new Map<string, StoredEventSubscription>();
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  private closeFlight: Promise<void> | undefined;
  private location: InboxLocation | undefined;
  private constructor(readonly directory: string, readonly sessionId: string, private lease: NativeLease) {}
  static async open(directory: string, sessionId: string): Promise<EventsRegistry> {
    if (!sessionId) throw new Error("Pi session identity is required");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lease = new DatabaseSync(join(directory, "consumer.sqlite"));
    try { lease.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (value INTEGER)"); }
    catch (error) {
      lease.close();
      if (/locked|busy/i.test(String(error))) throw new Error("Events session is already owned");
      throw error;
    }
    // SQLite's OS lock releases on process death; no racy PID-file reclamation.
    const registry = new EventsRegistry(directory, sessionId, lease);
    try {
      let text: string | undefined;
      try { text = await readFile(join(directory, "subscriptions.json"), "utf8"); }
      catch (error) { if (code(error) !== "ENOENT") throw error; }
      if (text !== undefined) {
        if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error("Events registry exceeds storage budget");
        const state = snapshot.parse(JSON.parse(text));
        if (state.sessionId !== sessionId) throw new Error("Events registry belongs to another Pi session");
        registry.location = state.inboxLocation;
        for (const entry of state.entries) {
          if (registry.entries.has(entry.id)) throw new Error("Duplicate Events registry identity");
          registry.entries.set(entry.id, entry);
        }
      }
      await registry.syncDirectory();
      return registry;
    } catch (error) { lease.close(); throw error; }
  }
  list(): StoredEventSubscription[] { return structuredClone([...this.entries.values()]); }
  /** Pin before inbox construction while this registry's exclusive lease is held.
   * Only the enum is persisted, never an arbitrary filesystem path. */
  pinInboxLocation(sharedDirectory: string): Promise<InboxLocation> {
    if (this.closed) return Promise.reject(new Error("Events registry is closed"));
    const pending = this.chain.then(async () => {
      const names = await readdir(join(this.directory, "inbox")).catch(error => {
        if (code(error) === "ENOENT") return []; throw error;
      });
      if (this.location === "shared" && names.length)
        throw new Error("Events inbox locations conflict with the pinned shared location");
      const selected: InboxLocation = this.location ?? (names.length ? "session" : "shared");
      if (selected === "session") {
        const shared: string[] = await readdir(sharedDirectory).catch(error => {
          if (code(error) === "ENOENT") return []; throw error;
        });
        if (shared.some(name => !["inbox.sqlite", "inbox.sqlite-journal"].includes(name)))
          throw new Error("Shared Events inbox requires explicit migration");
        if (shared.includes("inbox.sqlite")) {
          const db = new DatabaseSync(join(sharedDirectory, "inbox.sqlite"), { readOnly: true });
          try {
            db.exec("PRAGMA busy_timeout=2000; PRAGMA query_only=ON");
            const prefix = this.sessionId + "/";
            // Include acknowledged rows: tombstones are retained identity too.
            if (db.prepare("SELECT 1 FROM inbox_entries WHERE substr(scope,1,length(?))=? LIMIT 1").get(prefix, prefix))
              throw new Error("Events inbox locations conflict for this Pi session");
          } finally { db.close(); }
        } else if (shared.length) throw new Error("Shared Events inbox requires recovery");
      }
      if (!this.location) await this.write(this.entries, selected);
      return selected;
    });
    this.chain = pending.then(() => {}, () => {});
    return pending;
  }
  private async syncDirectory() {
    const file = await open(this.directory, "r");
    try { await file.sync(); } finally { await file.close(); }
  }
  save(raw: StoredEventSubscription): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Events registry is closed"));
    const entry = structuredClone(subscription.parse(raw));
    const pending = this.chain.then(async () => {
      const next = new Map(this.entries); next.set(entry.id, entry);
      await this.write(next, this.location);
    });
    this.chain = pending.catch(() => {});
    return pending;
  }
  private async write(next: Map<string, StoredEventSubscription>, location: InboxLocation | undefined) {
      if (next.size > 100) throw new Error("Events subscription limit reached");
      const text = JSON.stringify({ version: 1, sessionId: this.sessionId, ...(location ? { inboxLocation: location } : {}), entries: [...next.values()] });
      if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error("Events registry exceeds storage budget");
      const temporary = join(this.directory, `.${randomUUID()}.tmp`);
      try {
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
        await rename(temporary, join(this.directory, "subscriptions.json"));
        await this.syncDirectory(); this.entries = next; this.location = location;
      } finally { await unlink(temporary).catch(error => { if (code(error) !== "ENOENT") throw error; }); }
  }
  close(): Promise<void> {
    if (this.closeFlight) return this.closeFlight;
    this.closed = true;
    this.closeFlight = this.chain.then(async () => {
      this.lease.close();
    });
    return this.closeFlight;
  }
}
