import { createRequire } from "node:module";

const boundary = process.argv[3];
if (boundary === "before-commit" || boundary === "after-commit") {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const original = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function(sql: string) {
    const pause = () => {
      process.send!({ boundary });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); // SIGKILL while SQLite owns the transaction.
    };
    if (sql === "COMMIT" && boundary === "before-commit") pause();
    const result = original.call(this, sql);
    if (sql === "COMMIT" && boundary === "after-commit") pause();
    return result;
  };
}
const { DurableWebhookInbox } = await import("../../mcp-events-inbox.ts");
const inbox = new DurableWebhookInbox(process.argv[2]!);
const event = { eventId: "e1", name: "tick", timestamp: "2026-10-16T14:00:00Z", data: { value: 42 }, cursor: "c1" };
process.on("message", async () => {
  try {
    switch (process.argv[3]) {
      case "quota": {
        const id = process.argv[4]!;
        process.send!({ created: await inbox.accept("scope", id, { ...event, eventId: id }) }); break;
      }
      case "before-commit": case "after-commit": case "accept":
        process.send!({ created: await inbox.accept("scope", "e1", event) }); break;
      case "pending": process.send!({ pending: await inbox.pending("scope") }); break;
      case "ack": await inbox.acknowledge("scope", "e1"); process.send!({ acknowledged: true }); break;
      default: throw new Error("Unknown fixture action");
    }
  } catch (error) { process.send!({ error: String(error) }); }
});
process.send!({ ready: true });
