import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMcpAdapter } from "../index.ts";
import { createCompleteMcpClient } from "../complete.ts";
import type { ResourceReadPolicy } from "../types.ts";
import { installCore } from "../mcp-core.ts";
import * as skills from "../mcp-skills.ts";
import { McpServerManager } from "../server-manager.ts";
import { createProtocolSession } from "../runtime-protocol.ts";

const URI = "skill://acme/demo/SKILL.md", GUIDE = "skill://acme/demo/guide.txt";
const server = String.raw`
const readline = require("node:readline"), {createHash} = require("node:crypto");
const uri = "skill://acme/demo/SKILL.md", guide = "skill://acme/demo/guide.txt";
const text = "---\nname: demo\ndescription: Test\n---\n";
let mode = "normal", version = "verified guide", reads = 0, delay = false;
const pending = [];
const log = [], streams = new Set();
const files = () => [{uri, text}, {uri: guide, text: version}];
const entry = () => ({uri, frontmatter: {name:"demo", description:"Test"}, resources: mode === "dynamic" ? "dynamic" : files().map(f => ({uri:f.uri, size:Buffer.byteLength(f.text), digest:"sha256:"+createHash("sha256").update(f.text).digest("hex")}))});
const send = v => process.stdout.write(JSON.stringify(v)+"\n");
readline.createInterface({input:process.stdin}).on("line", line => {
 const q = JSON.parse(line); log.push({method:q.method, params:q.params});
 const reply = body => send({jsonrpc:"2.0", id:q.id, result:{resultType:"complete",ttlMs:0,cacheScope:"private",...body}});
 switch(q.method) {
 case "server/discover": return reply({supportedVersions:["2026-07-28"],capabilities:{tools:{},resources:{},extensions:{"io.modelcontextprotocol/skills":{}}}});
 case "tools/list": return reply({tools:[{name:"control",inputSchema:{type:"object",properties:{},additionalProperties:true}}]});
 case "resources/list": return reply({resources:[{uri:guide,name:"guide",mimeType:"text/plain"},{uri:"skill://acme/demo/new.txt",name:"extra",mimeType:"text/plain"}]});
 case "resources/templates/list": return reply({resourceTemplates:[]});
 case "subscriptions/listen": streams.add(q.id); return send({jsonrpc:"2.0",method:"notifications/subscriptions/acknowledged",params:{notifications:q.params.notifications,_meta:{"io.modelcontextprotocol/subscriptionId":q.id}}});
 case "skills/list": return reply({skills:[entry()]});
 case "skills/get": return reply({skill:entry()});
 case "tools/call": {
  const a=q.params.arguments||{}; if(a.mode) mode=a.mode; if(a.version) version=a.version;
  if(a.delay!==undefined) delay=a.delay;
  if(a.flush) {delay=false; for(const fn of pending.splice(0)) fn();}
  return reply({content:[{type:"text",text:JSON.stringify({reads,log})}]});
 }
 case "resources/read": {
  reads++; const requested=q.params.uri;
  const found=files().find(f=>f.uri===requested);
  const content={uri:mode==="substitute"?guide:requested,mimeType:"text/plain",text:mode==="tamper"?"tampered bytes":mode==="same-size"?"x".repeat(Buffer.byteLength(found?.text||"")):found?.text||"unlisted bytes"};
  if(mode==="blob") {content.blob=Buffer.from(content.text).toString("base64");delete content.text;}
  if(mode==="bad-blob") {content.blob="!!!!";delete content.text;}
  const respond=()=>reply({ttlMs:60000,contents:[content]});
  if(delay) pending.push(respond); else respond(); return;
 }
 default: if(q.id!==undefined) return send({jsonrpc:"2.0",id:q.id,error:{code:-32601,message:"unsupported"}});
 }
});`;
const definition = { command: process.execPath, args: ["-e", server], protocolVersion: "2026-07-28" as const, tasks: false, lifecycle: "eager" as const };

async function adapterFixture() {
  const policy = skills.createSkillsResourceReadPolicy();
  const manager = new McpServerManager(); manager.setResourceReadPolicy(policy.readResource);
  const connection = await manager.connect("fixture", definition);
  const session = createProtocolSession(connection, new AbortController().signal, skills.SKILLS_PROTOCOL);
  const client = new skills.SkillsClient(session, { server: "fixture", resourceReadPolicy: policy });
  const control = (args: Record<string, unknown>) => connection.client.callTool({ name: "control", arguments: args });
  return { policy, manager, connection, session, client, control, close: () => manager.closeAll() };
}

async function host(run: (h: {
  call: (name: string, args: Record<string, unknown>) => Promise<any>;
  policy: ReturnType<typeof skills.createSkillsResourceReadPolicy> | undefined;
  session: import("@earendil-works/pi-coding-agent").AgentSession;
  sessionManager: import("@earendil-works/pi-coding-agent").SessionManager;
}) => Promise<void>, restored = false, operatorPolicy?: ResourceReadPolicy) {
  const root = await mkdtemp(join(tmpdir(), "skills-policy-host-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agentDir = join(root, "agent"); process.env.PI_CODING_AGENT_DIR = agentDir;
  let session: import("@earendil-works/pi-coding-agent").AgentSession | undefined;
  try {
    await mkdir(agentDir);
    const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ModelRuntime, initTheme } = await import("@earendil-works/pi-coding-agent");
    const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
    const faux = fauxProvider({ provider: "skills-policy-host" });
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off" });
    const sessionManager = SessionManager.inMemory(root);
    if (restored) sessionManager.appendCustomEntry("mcp-complete-skills-window", { server: "fixture", uri: URI });
    const policy = skills.createSkillsResourceReadPolicy();
    const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      disabledBuiltinExtensions: ["mcp"], extensionFactories: [pi => {
        if (operatorPolicy) {
          createCompleteMcpClient({ config: { mcpServers: { fixture: definition }, settings: { directTools: true, autoAuth: false, sampling: false, elicitation: false } }, resourceReadPolicy: operatorPolicy })(pi);
          return;
        }
        createMcpAdapter({ config: { mcpServers: { fixture: definition }, settings: { directTools: true, autoAuth: false, sampling: false, elicitation: false } }, resourceReadPolicy: policy?.readResource })(pi);
        installCore(pi); skills.installSkills(pi, { resourceReadPolicy: policy });
      }],
    });
    await loader.reload(); expect(loader.getExtensions().errors).toEqual([]);
    ({ session } = await createAgentSession({ cwd: root, agentDir, modelRuntime, model: faux.getModel(), thinkingLevel: "off", resourceLoader: loader, settingsManager, sessionManager, noTools: "builtin" }));
    initTheme("dark", false);
    await session.bindExtensions({ mode: "tui", uiContext: { ...session.extensionRunner.getUIContext(), confirm: async () => true, notify() {} } });
    const active = session;
    const call = async (name: string, args: Record<string, unknown>) => {
      faux.setResponses([fauxAssistantMessage(fauxToolCall(name, args)), fauxAssistantMessage("Done.")]);
      await active.prompt("Run this operator-approved test call.");
      const result = active.messages.filter(message => message.role === "toolResult").at(-1);
      expect(result?.toolName).toBe(name); return result!;
    };
    await run({ call, policy, session: active, sessionManager });
  } finally {
    if (session) { await session.abort(); await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}

describe("held Skills manifests at real Pi resource-read surfaces", () => {
  it("preserves the operator resource policy when installing the complete client", async () => {
    await host(async ({ call }) => {
      const result = await call("fixture_read_guide", {});
      expect(JSON.stringify(result.content)).toContain("Operator denied this resource");
      expect(JSON.stringify(result.content)).not.toContain("verified guide");
    }, false, async () => { throw new Error("Operator denied this resource"); });
  }, 30000);
  it("rejects tampered core, direct and proxy reads after approved static activation", async () => {
    await host(async ({ call }) => {
      const results = [];
      for (const surface of ["core", "direct", "proxy"]) {
        await call("mcp", { server: "fixture", tool: "control", args: { mode: "normal" } });
        expect((await call("mcp_skills", { action: "load", server: "fixture", uri: URI })).isError).toBe(false);
        await call("mcp", { server: "fixture", tool: "control", args: { mode: surface === "core" ? "tamper" : "same-size" } });
        results.push(surface === "core" ? await call("mcp_protocol", { server: "fixture", action: "resources/read", params: { uri: GUIDE } }) :
          surface === "direct" ? await call("fixture_read_guide", {}) : await call("mcp", { server: "fixture", tool: "read_guide", args: {} }));
      }
      for (const result of results) {
        expect(JSON.stringify(result.content)).toContain("verification");
        expect(JSON.stringify(result.content)).not.toContain('"text":"tampered bytes"');
      }
    });
  }, 30000);
  it("rejects unlisted files across core/direct/proxy and keeps sibling roots readable", async () => {
    await host(async ({ call }) => {
      await call("mcp_skills", { action: "load", server: "fixture", uri: URI });
      expect((await call("mcp_skills", { action: "read", server: "fixture", uri: URI, path: "guide.txt" })).isError).toBe(false);
      for (const [name, args] of [
        ["mcp_protocol", { server: "fixture", action: "resources/read", params: { uri: "skill://acme/demo/new.txt" } }],
        ["mcp", { server: "fixture", tool: "read_extra", args: {} }],
        ["fixture_read_extra", {}],
      ] as const) expect(JSON.stringify((await call(name, args)).content)).toContain("Unlisted");
      expect((await call("mcp_protocol", { server: "fixture", action: "resources/read", params: { uri: "skill://acme/demo-other/guide.txt" } })).isError).toBe(false);
    });
  }, 30000);
  it("verifies stale SDK cache hits against the newly held manifest and revokes all readers", async () => {
    await host(async ({ call }) => {
      expect(JSON.stringify((await call("fixture_read_guide", {})).content)).toContain("verified guide");
      await call("mcp", { server: "fixture", tool: "control", args: { version: "new manifest bytes" } });
      await call("mcp_skills", { action: "load", server: "fixture", uri: URI });
      const inspect = async () => JSON.parse((await call("mcp", { server: "fixture", tool: "control", args: {} })).content[0].text);
      const before = await inspect();
      expect(JSON.stringify((await call("mcp", { server: "fixture", tool: "read_guide", args: {} })).content)).toContain("verification");
      const after = await inspect();
      expect(after.reads).toBe(before.reads); // Real SDK cache hit; no wire request.
      expect(JSON.stringify((await call("mcp", { server: "fixture", tool: "read_guide", args: {} })).content)).toContain("revoked");
      expect(JSON.stringify((await call("mcp_skills", { action: "read", server: "fixture", uri: URI, path: "guide.txt" })).content)).toContain("revoked");
    });
  }, 30000);
  it("blocks generic dynamic reads and retains the explicit Skills per-read consent path", async () => {
    await host(async ({ call }) => {
      await call("fixture_read_guide", {}); // Cache cannot confer dynamic approval.
      await call("mcp", { server: "fixture", tool: "control", args: { mode: "dynamic" } });
      expect((await call("mcp_skills", { action: "load", server: "fixture", uri: URI, allowUnpinned: true })).isError).toBe(false);
      expect(JSON.stringify((await call("mcp_skills", { action: "read", server: "fixture", uri: URI, path: "guide.txt" })).content)).toContain("verified guide");
      for (const [name, args] of [
        ["mcp_protocol", { server: "fixture", action: "resources/read", params: { uri: GUIDE } }],
        ["mcp", { server: "fixture", tool: "read_guide", args: {} }], ["fixture_read_guide", {}],
      ] as const) expect(JSON.stringify((await call(name, args)).content)).toContain("per-read approval");
    });
  }, 30000);
  it("restores acting windows as blocked roots until fresh activation, including after session replacement", async () => {
    await host(async ({ call, session }) => {
      expect(JSON.stringify((await call("fixture_read_guide", {})).content)).toContain("revoked");
      expect((await call("mcp_skills", { action: "load", server: "fixture", uri: URI })).isError).toBe(false);
      expect(JSON.stringify((await call("fixture_read_guide", {})).content)).toContain("verified guide");
      await session.extensionRunner.emit({ type: "session_start" });
      expect(JSON.stringify((await call("fixture_read_guide", {})).content)).toContain("revoked");
      expect(JSON.stringify((await call("mcp_protocol", { server: "fixture", action: "resources/read", params: { uri: GUIDE } })).content)).toContain("revoked");
    }, true);
  }, 30000);
  it("restores branch acting windows before returning a cached generic resource", async () => {
    await host(async ({ call, session, sessionManager }) => {
      expect(JSON.stringify((await call("fixture_read_guide", {})).content)).toContain("verified guide");
      sessionManager.appendCustomEntry("mcp-complete-skills-window", { server: "fixture", uri: URI });
      await session.extensionRunner.emit({ type: "session_tree" } as any);
      expect(JSON.stringify((await call("mcp", { server: "fixture", tool: "read_guide", args: {} })).content)).toContain("revoked");
    });
  }, 30000);
});

describe("held Skills policy over the real SDK/stdio adapter", () => {
  it("rejects an in-flight read after metadata revocation", async () => {
    const f = await adapterFixture();
    try {
      await f.client.load(URI, async () => true);
      await f.control({ delay: true });
      const reading = f.manager.readResource("fixture", GUIDE);
      const rejected = expect(reading).rejects.toThrow("revoked");
      await expect.poll(async () => {
        const report = await f.control({});
        return JSON.parse((report.content[0] as { text: string }).text).reads;
      }).toBe(2);
      await f.control({ version: "changed guide" }); await f.client.get(URI);
      await f.control({ flush: true }); await rejected;
    } finally { await f.close(); }
  });
  it("does not grant a concurrent generic read the verified loader's internal read scope", async () => {
    const f = await adapterFixture();
    try {
      await f.control({ delay: true });
      const loading = f.client.load(URI, async () => true);
      await expect.poll(async () => {
        const report = await f.control({});
        return JSON.parse((report.content[0] as { text: string }).text).reads;
      }).toBe(1);
      await expect(f.manager.readResource("fixture", GUIDE)).rejects.toThrow("revoked");
      await f.control({ flush: true }); await loading;
      expect(await f.manager.readResource("fixture", GUIDE)).toMatchObject({ contents: [{ text: "verified guide" }] });
    } finally { await f.close(); }
  });
  it("scopes identical URIs by originating server and policy instance", async () => {
    const a = await adapterFixture(), b = await adapterFixture();
    try {
      await a.client.load(URI, async () => true);
      a.policy.revoke("fixture", URI);
      await expect(a.manager.readResource("fixture", GUIDE)).rejects.toThrow("revoked");
      expect(await b.manager.readResource("fixture", GUIDE)).toMatchObject({ contents: [{ text: "verified guide" }] });
      const other = await a.manager.connect("other", definition);
      expect(await other.client.readResource({ uri: GUIDE })).toMatchObject({ contents: [{ text: "verified guide" }] });
    } finally { await Promise.all([a.close(), b.close()]); }
  });
  it("preserves unrelated opaque and query resource URIs after activation", async () => {
    const f = await adapterFixture();
    try {
      await f.client.load(URI, async () => true);
      for (const uri of ["urn:fixture:ordinary", "skill://acme/demo-other/guide.txt?format=text"]) {
        expect(await f.manager.readResource("fixture", uri)).toMatchObject({ contents: [{ uri, text: "unlisted bytes" }] });
      }
    } finally { await f.close(); }
  });
  it("validates binary bytes and rejects malformed base64 and substituted protected URIs", async () => {
    const f = await adapterFixture();
    try {
      await f.client.load(URI, async () => true);
      await f.control({ mode: "blob" });
      expect(await f.manager.readResource("fixture", GUIDE)).toMatchObject({ contents: [{ blob: Buffer.from("verified guide").toString("base64") }] });
      await f.control({ mode: "substitute" });
      await expect(f.connection.client.request({ method: "resources/read", params: { uri: "fixture://ordinary" } })).rejects.toThrow("substituted");
      await f.control({ mode: "bad-blob" });
      await expect(f.connection.client.request({ method: "resources/read", params: { uri: GUIDE } })).rejects.toThrow();
      await expect(f.manager.readResource("fixture", GUIDE)).rejects.toThrow("revoked");
    } finally { await f.close(); }
  });
});
