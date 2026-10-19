import { expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installEventDelivery } from "../mcp-events-pi-delivery.ts";

it("session replacement aborts a hung presentation policy and never queues or acknowledges its late output", async () => {
  const handlers = new Map<string, (...args: any[]) => any>(), sent: unknown[] = [], acked: unknown[] = [];
  const pi = { on: (name: string, callback: (...args: any[]) => any) => handlers.set(name, callback), sendMessage: (message: unknown) => sent.push(message) } as unknown as ExtensionAPI;
  let release!: (value: unknown) => void, started!: () => void, signal!: AbortSignal;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const output = new Promise<unknown>(resolve => { release = resolve; });
  const bridge = installEventDelivery(pi, { pending: async () => [{ subscriptionId: "sub", id: "e1", server: "fixture",
    delivery: { eventId: "e1", name: "tick", timestamp: "2026-10-17T00:00:00Z", data: { private: "old session" } } }],
    acknowledge: async rows => { acked.push(rows); },
  }, (_delivery, _context, ownedSignal) => { signal = ownedSignal; started(); return output; });
  const ctx = (id: string) => ({ sessionManager: { getSessionId: () => id, getEntries: () => [] } });
  handlers.get("session_start")!({}, ctx("a"));
  const notify = bridge.notify(); const rejected = expect(notify).rejects.toBeDefined();
  await waiting; handlers.get("session_start")!({}, ctx("b"));
  expect(signal.aborted).toBe(true);
  await rejected; // Must settle even if an operator policy ignores its signal.
  release({ late: "old session output" }); await Promise.resolve();
  expect(sent).toEqual([]); expect(acked).toEqual([]);
});
