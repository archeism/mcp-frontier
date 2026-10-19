import { expect, it } from "vitest";
import { happyCode, nativeHost } from "../verification/live-codemode-tasks.ts";

// Characterization of existing production behavior; no manufactured RED.
it.each(["modern", "legacy"] as const)("native Pi codemode-only composes complete Tasks with trust, structured envelopes, cancellation and recovery (%s)", async era => {
  const h = await nativeHost(era);
  const run = async (code: string, id: string, sampling = false) => {
    h.faux.setResponses([h.fauxAssistantMessage(h.fauxToolCall("codemode", { code }, { id })),
      ...(sampling ? [h.fauxAssistantMessage("TASK_SAMPLING_APPROVED_RESULT")] : []), h.fauxAssistantMessage("Done.")]);
    await h.session.prompt("Execute the native codemode script.");
    return h.session.messages.find(message => message.role === "toolResult" && message.toolCallId === id);
  };
  try {
    if (era === "legacy") h.expire();
    const happy = await run(happyCode, "native-happy", true);
    expect(happy).toMatchObject({ isError: false, nestedCalls: { calls: [
      { id: "native-happy/1", name: "trust_sampling", status: "ok" },
      { id: "native-happy/2", name: "trust_elicitation", status: "ok" },
    ] } });
    expect(JSON.stringify(happy)).toContain("TASK_SAMPLING_APPROVED_RESULT");
    expect(JSON.stringify(happy)).toContain('content');
    const calls = h.fixture.wire.filter(row => row.direction === "client" && row.frame.method === "tools/call");
    expect(calls.map(row => row.frame.params?._meta?.["pi-mcp-adapter/toolCallId"])).toEqual(["native-happy/1", "native-happy/2"]);
    expect(h.fixture.tasks.size).toBe(2); if (era === "legacy") expect(h.sessions()).toBe(2);
    expect(h.approvals).toContain("Approve MCP sampling request"); expect(h.approvals).toContain("Return MCP sampling response");
    h.decide("decline");
    const denied = await run('text(await tools.trust_elicitation({}));', "native-denied");
    expect(denied).toMatchObject({ isError: false });
    expect(h.fixture.inputs.at(-1)?.response.action).toBe("decline");
    const nestedBefore = h.nested.length;
    const invalid = await run('text(await tools.trust_sampling({}));', "native-error");
    expect(JSON.stringify(invalid)).toContain("declined");
    expect(h.nested).toHaveLength(nestedBefore);
    if (era === "modern") expect(JSON.stringify(invalid)).toContain('isError');
    h.decide("hold"); const before = h.approvals.length, answers = h.fixture.inputs.length;
    const running = run('text(await tools.trust_elicitation({}));', "native-cancel");
    await expect.poll(() => h.approvals.length).toBeGreaterThan(before);
    const interrupted = [...h.fixture.tasks.keys()].at(-1)!;
    await h.session.abort(); h.release(); await running;
    expect(h.fixture.inputs).toHaveLength(answers);
    await expect.poll(() => h.fixture.wire.some(row => row.direction === "client" && row.frame.method === "tasks/cancel"
      && row.frame.params?.taskId === interrupted)).toBe(true);
    expect(h.providerTools.length).toBeGreaterThan(0);
    expect(h.providerTools.every(names => names.length === 1 && names[0] === "codemode")).toBe(true);
    expect(h.fixture.violations).toEqual([]); expect(h.errors).toEqual([]);
  } finally { h.release(); await h.close(); }
}, 30000);
