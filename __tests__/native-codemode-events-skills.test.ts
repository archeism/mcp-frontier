import { expect, it } from "vitest";
import { createCodemodeHost, proveEvents, proveSkills } from "./fixtures/native-codemode-events-skills.ts";

it("scripted provider / actual Pi 1.3 keeps all Events paths nested across idle wake and persistent restart", async () => {
  const host = await createCodemodeHost();
  try {
    const checks = await proveEvents(host);
    expect(checks.map(row => row.mode)).toEqual(["poll", "push", "webhook"]);
    expect(checks.every(row => row.receipt && row.acknowledged && row.idleCodemode)).toBe(true);
    expect(checks.every(row => row.eventDerived && row.promptUnaware)).toBe(true);
    await proveSkills(host);
    expect(host.replayProof()).toMatchObject({ reconciled: true, duplicateMessages: 0, automaticTurns: 0, automaticProviderRequests: 0 });
    expect(host.providerTools.length).toBeGreaterThan(6);
    expect(host.providerTools.every(names => JSON.stringify(names) === '["codemode"]')).toBe(true);
    expect(host.nested.some(row => row.name === "mcp_events" && !!row.parent)).toBe(true);
    expect(host.errors).toEqual([]);
  } finally { await host.close(); }
}, 30000);

it("scripted provider / nested mcp_skills preserves metadata-only discovery, consent, integrity and origin gates", async () => {
  const host = await createCodemodeHost();
  try {
    await proveSkills(host);
    expect(host.nested.some(row => row.name === "mcp_skills" && !!row.parent)).toBe(true);
    expect(host.providerTools.every(names => JSON.stringify(names) === '["codemode"]')).toBe(true);
    expect(host.errors).toEqual([]);
  } finally { await host.close(); }
}, 30000);
