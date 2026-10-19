import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createCompleteMcpClient } from "../complete.ts";
import { startTaskTrustServer } from "./fixtures/task-trust-server.mjs";

it("live fixture sampling budget reaches the task input without changing the default", async () => {
  for (const samplingMaxTokens of [undefined, 2048]) {
    const server = await startTaskTrustServer({ samplingMaxTokens });
    try {
      const rpc = async (method: string, params: object) => {
        const response = await fetch(server.url, { method: "POST", headers: {
          "content-type": "application/json", Authorization: "Bearer task-trust-fixture",
        }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
        return (await response.json()).result;
      };
      const task = await rpc("tools/call", { name: "sampling", arguments: {} });
      const snapshot = await rpc("tasks/get", { taskId: task.taskId });
      expect(snapshot.inputRequests.input.params.maxTokens).toBe(samplingMaxTokens ?? 100);
    } finally { await server.close(); }
  }
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function host(server: Awaited<ReturnType<typeof startTaskTrustServer>>, decide: (title: string, message: string) => Promise<boolean>) {
  const root = await mkdtemp(join(tmpdir(), "task-trust-pi-")), agentDir = join(root, "agent"); await mkdir(agentDir);
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
  const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ModelRuntime, initTheme } = await import("@earendil-works/pi-coding-agent");
  const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null,
    modelsStorePath: join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  const faux = fauxProvider({ provider: "task-trust-host" }); runtime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off" }); settingsManager.setRetryEnabled(false);
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noContextFiles: true, noThemes: true, disabledBuiltinExtensions: ["mcp"],
    extensionFactories: [createCompleteMcpClient({ config: { mcpServers: { trust: { url: server.url, auth: false,
      headers: { Authorization: "Bearer task-trust-fixture" }, protocolVersion: server.era === "legacy" ? "legacy" : "2026-07-28", tasks: true, lifecycle: "eager" } },
      settings: { sampling: true, samplingAutoApprove: false, elicitation: true, approveTools: false, directTools: false,
        autoAuth: false, scriptMode: true, requestTimeoutMs: 3000 } } })] });
  await loader.reload(); expect(loader.getExtensions().errors).toEqual([]);
  const { session } = await createAgentSession({ cwd: root, agentDir, modelRuntime: runtime, model: faux.getModel(),
    thinkingLevel: "off", resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(root), noTools: "builtin" });
  initTheme("dark", false);
  await session.bindExtensions({ mode: "tui", uiContext: { ...session.extensionRunner.getUIContext(),
    confirm: decide, select: async title => await decide(title, "") ? "Continue" : "Decline", notify() {} } });
  return { session, faux, fauxAssistantMessage, fauxToolCall,
    async close() { await session.abort(); await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose();
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(root, { recursive: true, force: true }); } };
}

it.each(["accept", "decline-request", "decline-response"] as const)("actual Pi task sampling %s uses production approval gates before provider and before wire return", async decision => {
  const server = await startTaskTrustServer();
  const approvals: string[] = []; let modelCalls = 0;
  const approvalGate = gate();
  const heldTitle = decision === "decline-response" ? "Return MCP sampling response" : "Approve MCP sampling request";
  const h = await host(server, async title => { approvals.push(title);
    if (title === heldTitle) await approvalGate.promise;
    return !(decision === "decline-request" && title === "Approve MCP sampling request") &&
      !(decision === "decline-response" && title === "Return MCP sampling response"); });
  try {
    const nested = async () => {
      expect(approvals).toContain("Approve MCP sampling request");
      expect(approvals).not.toContain("Return MCP sampling response");
      expect(server.inputs).toHaveLength(0); modelCalls++;
      return h.fauxAssistantMessage("TASK_SAMPLING_APPROVED_RESULT");
    };
    h.faux.setResponses([h.fauxAssistantMessage(h.fauxToolCall("mcp", { server: "trust", tool: "sampling", args: {} })),
      ...(decision === "decline-request" ? [] : [nested]), h.fauxAssistantMessage("Done.")]);
    const running = h.session.prompt("Execute the configured task-backed sampling tool.");
    await expect.poll(() => approvals.includes(heldTitle)).toBe(true);
    expect(modelCalls).toBe(decision === "decline-response" ? 1 : 0);
    expect(server.inputs).toHaveLength(0);
    expect(server.wire.filter(row => row.direction === "client" && row.frame.method === "tasks/update")).toEqual([]);
    approvalGate.release(); await running;
    expect(server.tasks.size).toBe(1);
    expect(modelCalls).toBe(decision === "decline-request" ? 0 : 1);
    const response = server.inputs[0]?.response;
    if (decision === "accept") expect(JSON.stringify(response)).toContain("TASK_SAMPLING_APPROVED_RESULT");
    else {
      expect(JSON.stringify(server.wire.filter(row => row.direction === "client"))).not.toContain("TASK_SAMPLING_APPROVED_RESULT");
      expect(JSON.stringify(h.session.messages)).toContain("MCP sampling request was declined");
      // The SDK has no sampling decline result: denial stops local work and
      // withholds this input, rather than fabricating an accept/error payload.
      expect(server.wire.filter(row => row.direction === "client" && row.frame.method === "tasks/update")).toEqual([]);
      expect(response).toBeUndefined();
    }
    expect(server.violations).toEqual([]);
  } finally { approvalGate.release(); await h.close(); await server.close(); }
}, 15000);

it.each([true, false])("actual Pi task elicitation approval=%s appears as accept/decline in tasks/update", async approved => {
  const server = await startTaskTrustServer(); const approvals: string[] = [];
  const h = await host(server, async title => { approvals.push(title); return approved; });
  try {
    h.faux.setResponses([h.fauxAssistantMessage(h.fauxToolCall("mcp", { server: "trust", tool: "elicitation", args: {} })), h.fauxAssistantMessage("Done.")]);
    await h.session.prompt("Execute the configured task-backed elicitation tool.");
    expect(approvals.some(title => title.includes("TASK_ELICIT_trust-1"))).toBe(true);
    expect(server.inputs[0]?.response).toMatchObject({ action: approved ? "accept" : "decline" });
    const update = server.wire.find(row => row.direction === "client" && row.frame.method === "tasks/update");
    expect(update?.frame.params.inputResponses.input.action).toBe(approved ? "accept" : "decline");
    expect(server.violations).toEqual([]);
  } finally { await h.close(); await server.close(); }
}, 15000);

it("two actual Pi legacy tool tasks preemptively wait tasks/result on input_required and retain related-task association", async () => {
  const server = await startTaskTrustServer({ era: "legacy" }); const prompts: string[] = [];
  const h = await host(server, async title => { prompts.push(title); return true; });
  try {
    h.faux.setResponses([h.fauxAssistantMessage(h.fauxToolCall("mcpScript", { code: 'emit(await Promise.all([tools.call("trust_elicitation", {}), tools.call("trust_elicitation", {})]));' })), h.fauxAssistantMessage("Done.")]);
    const running = h.session.prompt("Execute both legacy tool tasks concurrently.");
    await expect.poll(() => [...server.tasks.values()].filter(state => state.polls > 0).length).toBe(2);
    await expect.poll(() => [...server.tasks.values()].filter(state => state.resultRequests > 0).length, { timeout: 1500 }).toBe(2);
    await running;
    expect(server.inputs).toHaveLength(2);
    const peers = server.wire.filter(row => row.direction === "server" && row.frame.method === "elicitation/create");
    expect(peers).toHaveLength(2);
    for (const row of server.inputs) {
      expect(row.request.params._meta["io.modelcontextprotocol/related-task"].taskId).toBe(row.taskId);
      expect(row.response.action).toBe("accept");
      expect(prompts.some(title => title.includes(`TASK_ELICIT_${row.taskId}`))).toBe(true);
    }
  } finally { await h.close(); await server.close(); }
}, 15000);

it("interleaved legacy task inputs retain distinct related-task decisions and JSON-RPC response association", async () => {
  const server = await startTaskTrustServer({ era: "legacy", requireResult: false });
  const prompts: string[] = []; let release!: () => void;
  const bothPrompts = new Promise<void>(resolve => { release = resolve; });
  const h = await host(server, async title => {
    if (!title.includes("TASK_ELICIT_")) return true;
    prompts.push(title); if (prompts.length === 2) release();
    await bothPrompts;
    return title.includes("TASK_ELICIT_trust-1");
  });
  try {
    h.faux.setResponses([h.fauxAssistantMessage(h.fauxToolCall("mcpScript", { code: 'emit(await Promise.all([tools.call("trust_elicitation", {}), tools.call("trust_elicitation", {})]));' })), h.fauxAssistantMessage("Done.")]);
    await h.session.prompt("Handle both correlated legacy task inputs.");
    expect(prompts).toHaveLength(2); expect(server.inputs).toHaveLength(2);
    for (const row of server.inputs) {
      expect(row.request.params._meta["io.modelcontextprotocol/related-task"].taskId).toBe(row.taskId);
      expect(row.response.action).toBe(row.taskId === "trust-1" ? "accept" : "decline");
      const peer = server.wire.find(entry => entry.direction === "server" && entry.frame.method === "elicitation/create" &&
        entry.frame.params._meta["io.modelcontextprotocol/related-task"].taskId === row.taskId);
      expect(peer).toBeDefined();
      const answer = server.wire.find(entry => entry.direction === "client" && entry.frame.id === peer.frame.id && entry.frame.result);
      expect(answer?.frame.result.action).toBe(row.response.action);
      expect(answer?.frame.result._meta?.["io.modelcontextprotocol/related-task"]?.taskId).toBe(row.taskId);
    }
  } finally { release(); await h.close(); await server.close(); }
}, 15000);

it.each(["missing", "malformed", "cross-task"] as const)("legacy %s correlation cannot borrow task approval: normal standalone trust gates may decline", async correlation => {
  const server = await startTaskTrustServer({ era: "legacy", correlation, requireResult: false }); const prompts: string[] = [];
  const h = await host(server, async title => { prompts.push(title); return !title.includes("TASK_ELICIT_"); });
  try {
    h.faux.setResponses([h.fauxAssistantMessage(h.fauxToolCall("mcpScript", { code: 'emit(await Promise.all([tools.call("trust_elicitation", {}), tools.call("trust_elicitation", {})]));' })), h.fauxAssistantMessage("Done.")]);
    await h.session.prompt("Exercise both legacy task inputs.");
    expect(server.inputs).toHaveLength(2);
    expect(server.wire.filter(row => row.direction === "server" && row.frame.method === "elicitation/create")).toHaveLength(2);
    expect(server.inputs.every(row => row.response.action !== "accept")).toBe(true);
    if (correlation === "cross-task") for (const row of server.inputs) {
      const claimed = row.request.params._meta["io.modelcontextprotocol/related-task"].taskId;
      expect(claimed).not.toBe(row.taskId);
      expect(server.tasks.has(claimed)).toBe(true);
    }
    // No correlation evidence is not proof of task dependence. If the ordinary
    // request handler serves it, it must ask independently and honor denial.
    for (const row of server.inputs) if (row.response.action === "decline")
      expect(prompts.some(title => title.includes(`TASK_ELICIT_${row.taskId}`))).toBe(true);
  } finally { await h.close(); await server.close(); }
}, 15000);

it("absent related-task metadata remains a normally approved standalone input while two tasks are pending", async () => {
  const server = await startTaskTrustServer({ era: "legacy", correlation: "missing", requireResult: false });
  const prompts: string[] = [];
  const h = await host(server, async title => { prompts.push(title); return true; });
  try {
    h.faux.setResponses([h.fauxAssistantMessage(h.fauxToolCall("mcpScript", { code: 'emit(await Promise.all([tools.call("trust_elicitation", {}), tools.call("trust_elicitation", {})]));' })), h.fauxAssistantMessage("Done.")]);
    await h.session.prompt("Handle independently gated standalone requests while tasks are pending.");
    expect(server.inputs).toHaveLength(2);
    expect(prompts.filter(title => title.includes("TASK_ELICIT_"))).toHaveLength(2);
    for (const row of server.inputs) {
      expect(row.request.params._meta).toBeUndefined(); expect(row.response.action).toBe("accept");
      const peer = server.wire.find(entry => entry.direction === "server" && entry.frame.method === "elicitation/create" &&
        entry.frame.params.message === `TASK_ELICIT_${row.taskId}`);
      expect(peer).toBeDefined();
      const answer = server.wire.find(entry => entry.direction === "client" && entry.frame.id === peer.frame.id && entry.frame.result);
      expect(answer?.frame.result._meta?.["io.modelcontextprotocol/related-task"]).toBeUndefined();
    }
  } finally { await h.close(); await server.close(); }
}, 15000);
