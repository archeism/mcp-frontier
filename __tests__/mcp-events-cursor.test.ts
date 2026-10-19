import { expect, it } from "vitest";
import { PollEventsClient } from "../mcp-events-advanced.ts";
import type { McpProtocolSession } from "../runtime-protocol.ts";

it("an absent poll response cursor replaces a previous recovery token with null", async () => {
  const controller = new AbortController(), deliveries: any[] = [], requests: unknown[] = [];
  const session: McpProtocolSession = { signal: controller.signal, protocolVersion: "2026-07-28", serverCapabilities: { events: {} },
    getEventsCapabilities: async () => ({}), close: () => controller.abort(),
    watchNotifications: () => ({ close() {}, closed: new Promise(() => {}) }), openStream: () => { throw new Error("No push"); },
    request: async (method, params) => {
      if (method === "events/list") return { events: [{ name: "tick", delivery: ["poll"], inputSchema: {}, payloadSchema: {} }] };
      requests.push(params); return { events: [], truncated: true, nextPollMs: 60000 };
    },
  };
  const client = new PollEventsClient("fixture", session, body => { deliveries.push(body); });
  try {
    expect(await client.subscribe("tick", {}, "previous")).toMatchObject({ cursor: null, truncated: false });
    expect(requests).toMatchObject([{ cursor: "previous" }]);
    expect(deliveries).toMatchObject([{ cursor: null, truncated: false, events: [] }]);
  } finally { client.close(); }
});
