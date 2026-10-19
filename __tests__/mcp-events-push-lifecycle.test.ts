import { afterEach, expect, it, vi } from "vitest";
import { EventConnection, type PushOptions } from "../event-companion/src/stream.ts";
import type { ProtocolSession } from "../event-companion/src/protocol.ts";

afterEach(() => vi.useRealTimers());
function fixture(options: PushOptions = {}, initial: Record<string, unknown> = { cursor: "initial" }) {
  const streams: Array<{ params: Record<string, unknown>; receive: (method: string, params: Record<string, unknown>) => void; cancel: ReturnType<typeof vi.fn> }> = [];
  const delivered: unknown[] = [], gaps: unknown[] = [];
  const session: ProtocolSession = { signal: new AbortController().signal, close() {},
    request: async () => ({ events: [{ name: "tick", delivery: ["push"], inputSchema: {}, payloadSchema: {} }] }),
    watchNotifications: () => ({ close() {}, closed: new Promise(() => {}) }),
    openStream: (_method, params, receive) => {
      const cancel = vi.fn(async () => {}); streams.push({ params, receive, cancel });
      queueMicrotask(() => receive("notifications/events/active", initial));
      return { id: "wire-" + streams.length, sent: Promise.resolve(), closed: new Promise(() => {}), cancel };
    },
  };
  const driver = new EventConnection("fixture", session, (_sub, event) => delivered.push(event), undefined, sub => gaps.push({ ...sub }), 15000,
    { heartbeatTimeoutMs: 100, retryBaseMs: 10, reconnect: async () => session, ...options });
  const send = async (kind: string, params: Record<string, unknown>) => {
    streams.at(-1)!.receive("notifications/events/" + kind, params);
    await vi.advanceTimersByTimeAsync(0);
  };
  return { driver, streams, send, delivered, gaps };
}

it("quiet heartbeat cursor waits for acceptance; a silent stream reconnects with that checkpoint", async () => {
  vi.useFakeTimers(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ checkpoint: async sub => { if (sub.cursor === "quiet") await gate; } });
  try {
    const sub = await f.driver.subscribe("tick", {});
    await f.send("heartbeat", { cursor: "quiet" }); expect(sub.cursor).toBe("initial");
    release(); await vi.advanceTimersByTimeAsync(0); expect(sub.cursor).toBe("quiet");
    expect(f.delivered).toEqual([]);
    await vi.advanceTimersByTimeAsync(99); expect(f.streams).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); expect(sub.status).toBe("reconnecting");
    expect(f.streams[0]!.cancel).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10); expect(f.streams).toHaveLength(2);
    expect(f.streams[1]!.params.cursor).toBe("quiet");
  } finally { release(); f.driver.close(); }
});

it("midstream gap and transient per-occurrence error keep the same stream and resume events", async () => {
  vi.useFakeTimers(); const f = fixture();
  try {
    const sub = await f.driver.subscribe("tick", {});
    await f.send("active", { cursor: "fresh", truncated: true });
    expect(sub).toMatchObject({ status: "active", cursor: "fresh", truncated: true }); expect(f.gaps).toHaveLength(1);
    await f.send("error", { error: { code: -32603, message: "Temporary fetch failure" } });
    expect(sub.status).toBe("active"); expect(sub.error).toBe("Temporary fetch failure");
    await f.send("event", { eventId: "e1", name: "tick", timestamp: "2026-10-17T00:00:00Z", data: {}, cursor: "after" });
    expect(sub.cursor).toBe("after"); expect(sub.error).toBeUndefined(); expect(f.delivered).toHaveLength(1);
    expect(f.streams).toHaveLength(1); expect(f.streams[0]!.cancel).not.toHaveBeenCalled();
  } finally { f.driver.close(); }
});

it.each(["active", "heartbeat", "event"])("absent %s cursor clears an older recovery position to null", async kind => {
  vi.useFakeTimers(); const f = fixture();
  try {
    const sub = await f.driver.subscribe("tick", {});
    await f.send(kind, kind === "event" ? { eventId: "e1", name: "tick", timestamp: "2026-10-17T00:00:00Z", data: {} } : { truncated: true });
    expect(sub.cursor).toBe(null);
    if (kind === "active") { expect(sub.truncated).toBe(false); expect(f.gaps).toEqual([]); }
    await vi.advanceTimersByTimeAsync(110);
    expect(f.streams[1]!.params.cursor).toBe(null);
  } finally { f.driver.close(); }
});

it("an absent initial activation cursor is accepted as null", async () => {
  vi.useFakeTimers(); const f = fixture({}, {});
  try { expect(await f.driver.subscribe("tick", {}, "old")).toMatchObject({ status: "active", cursor: null }); }
  finally { f.driver.close(); }
});
