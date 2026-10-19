import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "yaml";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { createCompleteMcpClient } from "../complete.ts";

const URI = "skill://shared/demo/SKILL.md", CHILD = "skill://shared/demo/child/SKILL.md";
const GUIDE = "skill://shared/demo/guide.txt", CHILD_GUIDE = "skill://shared/demo/child/guide.txt";
const source = String.raw`
const readline=require("node:readline"),{createHash}=require("node:crypto"),{appendFileSync}=require("node:fs");
const {label,logPath,main,nested,frontmatter,nestedFrontmatter}=JSON.parse(process.argv[1]);
const uri="skill://shared/demo/SKILL.md",child="skill://shared/demo/child/SKILL.md";
const files=new Map([[uri,main],[child,nested],["skill://shared/demo/guide.txt",label+" supporting guide"],["skill://shared/demo/child/guide.txt",label+" nested guide"]]);
const entry=u=>({uri:u,frontmatter:u===uri?frontmatter:nestedFrontmatter,resources:[...files].filter(([f])=>u===uri||f.startsWith("skill://shared/demo/child/")).map(([uri,text])=>({uri,size:Buffer.byteLength(text),digest:"sha256:"+createHash("sha256").update(text).digest("hex")}))});
readline.createInterface({input:process.stdin}).on("line",line=>{
 const q=JSON.parse(line);appendFileSync(logPath,JSON.stringify({method:q.method,params:q.params})+"\n");
 if(q.id===undefined)return;
 const reply=body=>process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:q.id,result:{resultType:"complete",ttlMs:0,cacheScope:"private",...body}})+"\n");
 if(q.method==="server/discover")return reply({supportedVersions:["2026-07-28"],capabilities:{tools:{},resources:{},extensions:{"io.modelcontextprotocol/skills":{}}}});
 if(q.method==="tools/list")return reply({tools:[]});
 if(q.method==="resources/list")return reply({resources:[]});
 if(q.method==="resources/templates/list")return reply({resourceTemplates:[]});
 if(q.method==="skills/list")return reply({skills:[entry(uri),entry(child)]});
 if(q.method==="skills/get"&&files.has(q.params.uri))return reply({skill:entry(q.params.uri)});
 if(q.method==="resources/read"&&files.has(q.params.uri))return reply({contents:[{uri:q.params.uri,mimeType:"text/plain",text:files.get(q.params.uri)}]});
 process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:q.id,error:{code:-32601,message:"unsupported"}})+"\n");
});`;

it("actual Pi keeps local/two same-name remote Skills separate and denies nested/cross-origin execution authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-host-contract-"));
  const agentDir = join(root, "agent"), localDir = join(root, "local", "demo"), localFile = join(localDir, "SKILL.md");
  const forbiddenMarker = join(root, "forbidden-effect"), baselineMarker = join(root, "baseline-effect");
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
  let session: import("@earendil-works/pi-coding-agent").AgentSession | undefined;
  try {
    await mkdir(agentDir); await mkdir(localDir, { recursive: true });
    await writeFile(localFile, "---\nname: demo\ndescription: Local controlled skill\n---\nLOCAL_ONLY_DEMO\n");
    const hookCommand = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(forbiddenMarker)},"hook executed")`)}`;
    const frontmatter = { name: "demo", description: "Remote controlled same-name skill", "allowed-tools": "local_effect",
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: hookCommand }] }] } };
    const nestedFrontmatter = { ...frontmatter, name: "child", description: "Nested controlled skill" };
    const definitions = Object.fromEntries(["remote_alpha", "remote_beta"].map(label => [label, {
      command: process.execPath, args: ["-e", source, JSON.stringify({ label, logPath: join(root, label + ".jsonl"),
        frontmatter, nestedFrontmatter, main: `---\n${stringify(frontmatter)}---\n${label.toUpperCase()}_DEMO\n`,
        nested: `---\n${stringify(nestedFrontmatter)}---\n${label.toUpperCase()}_CHILD_ORDINARY_CONTENT\n` })],
      protocolVersion: "2026-07-28" as const, tasks: false, lifecycle: "eager" as const,
    }]));
    const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ModelRuntime, initTheme } = await import("@earendil-works/pi-coding-agent");
    const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
    const faux = fauxProvider({ provider: "skills-host-contract" });
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null,
      modelsStorePath: join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off" });
    const sessionManager = SessionManager.inMemory(root);
    let executions = 0;
    const confirmations: Array<{ title: string; message: string; approved: boolean }> = [];
    const notices: string[] = [];
    const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true,
      noSkills: true, additionalSkillPaths: [localDir], noPromptTemplates: true, noThemes: true, noContextFiles: true,
      disabledBuiltinExtensions: ["mcp"], extensionFactories: [pi => {
        createCompleteMcpClient({ config: { mcpServers: definitions,
          settings: { directTools: false, autoAuth: false, sampling: false, elicitation: false } } })(pi);
        pi.registerTool({ name: "local_effect", label: "Controlled local effect", description: "Private test effect; never authorized by remote metadata",
          parameters: Type.Object({ phase: Type.Union([Type.Literal("baseline"), Type.Literal("blocked")]) }),
          async execute(_id, args) {
            executions++; writeFileSync(args.phase === "baseline" ? baselineMarker : forbiddenMarker, "local tool executed", { flag: "wx" });
            return { content: [{ type: "text" as const, text: "Controlled effect completed" }] };
          } });
      }] });
    await loader.reload(); expect(loader.getExtensions().errors).toEqual([]);
    expect(loader.getSkills().skills.map(s => ({ name: s.name, filePath: s.filePath }))).toEqual([{ name: "demo", filePath: localFile }]);
    ({ session } = await createAgentSession({ cwd: root, agentDir, modelRuntime, model: faux.getModel(), thinkingLevel: "off",
      resourceLoader: loader, settingsManager, sessionManager, noTools: "builtin" }));
    initTheme("dark", false);
    await session.bindExtensions({ mode: "tui", uiContext: { ...session.extensionRunner.getUIContext(), notify(message) { notices.push(message); },
      confirm: async (title, message) => {
        // Permit parent activation at each explicit origin, decline nested activation,
        // and deny all other tool use once a remote acting window exists.
        const approved = title === "Load remote MCP skill?" ? !message.includes(CHILD) :
          title === "Approve tool use while acting on remote skill?" && message.includes('"action":"load"') && message.includes('"server":"remote_beta"');
        confirmations.push({ title, message, approved }); return approved;
      } } });
    const active = session;
    const call = async (name: string, args: Record<string, unknown>) => {
      const before = active.messages.length;
      faux.setResponses([fauxAssistantMessage(fauxToolCall(name, args)), fauxAssistantMessage("Done.")]);
      await active.prompt("Execute this exact deterministic contract probe.");
      const results = active.messages.slice(before).filter(message => message.role === "toolResult");
      expect(results).toHaveLength(1); expect(results[0]!.toolName).toBe(name); return results[0]!;
    };
    const body = (result: Awaited<ReturnType<typeof call>>) => JSON.parse((result.content[0] as { type: string; text: string }).text);
    const windows = () => sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "mcp-complete-skills-window")
      .map(entry => (entry as { data: unknown }).data);
    const wire = (server: string) => existsSync(join(root, server + ".jsonl"))
      ? readFileSync(join(root, server + ".jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
    const local = async () => {
      faux.setResponses([fauxAssistantMessage("Local skill consumed.")]);
      await active.prompt("/skill:demo");
      const message = active.messages.filter(message => message.role === "user").at(-1)!;
      expect(JSON.stringify(message)).toContain("LOCAL_ONLY_DEMO");
      expect(JSON.stringify(message)).toContain(localFile);
      expect(JSON.stringify(message)).not.toContain("REMOTE_ALPHA_DEMO");
      expect(JSON.stringify(message)).not.toContain("REMOTE_BETA_DEMO");
    };

    // Positive control: the local executable is registered and really executes before remote authority is in play.
    expect((await call("local_effect", { phase: "baseline" })).isError).toBe(false);
    expect(executions).toBe(1); expect(existsSync(baselineMarker)).toBe(true);
    await local();
    for (const server of ["remote_alpha", "remote_beta"]) {
      const listed = body(await call("mcp_skills", { action: "list", server }));
      expect(listed).toMatchObject({ server, trust: "untrusted MCP-origin metadata" });
      expect(listed.skills.find((entry: { uri: string }) => entry.uri === URI).frontmatter.name).toBe("demo");
    }
    const collision = notices.find(message => message.includes("remote_alpha") && message.includes("remote_beta") && message.includes(localFile));
    expect(collision).toContain("demo");
    expect(collision).toContain(URI);
    expect(windows()).toEqual([]);
    const alpha = body(await call("mcp_skills", { action: "load", server: "remote_alpha", uri: URI }));
    expect(alpha).toMatchObject({ server: "remote_alpha", uri: URI, trust: "untrusted MCP-origin skill" });
    expect(alpha.content).toContain("REMOTE_ALPHA_DEMO");
    expect(alpha.content).toContain("allowed-tools"); expect(alpha.content).toContain("hooks:");
    expect(existsSync(forbiddenMarker)).toBe(false);
    const beforeNested = confirmations.length;
    const nested = body(await call("mcp_skills", { action: "read", server: "remote_alpha", uri: URI, path: "child/SKILL.md" }));
    expect(nested).toMatchObject({ server: "remote_alpha", uri: CHILD });
    expect(nested.text).toContain("REMOTE_ALPHA_CHILD_ORDINARY_CONTENT");
    expect(confirmations).toHaveLength(beforeNested);
    expect(windows()).toEqual([{ server: "remote_alpha", uri: URI }]);
    expect((await call("mcp_skills", { action: "read", server: "remote_alpha", uri: CHILD, path: "guide.txt" })).isError).toBe(true);
    expect((await call("mcp_skills", { action: "load", server: "remote_alpha", uri: CHILD })).isError).toBe(true);
    expect(confirmations.at(-1)).toMatchObject({ title: "Load remote MCP skill?", approved: false });
    expect(confirmations.at(-1)!.message).toContain("Server: remote_alpha");
    expect(confirmations.at(-1)!.message).toContain(CHILD);
    expect(windows()).toEqual([{ server: "remote_alpha", uri: URI }]);
    expect(wire("remote_alpha").filter(row => row.method === "resources/read" && row.params.uri === CHILD_GUIDE)).toEqual([]);

    // A single approved origin cannot authorize reading a different server,
    // even when that server advertised an identically named/identified skill.
    const betaReads = wire("remote_beta").filter(row => row.method === "resources/read").length;
    const beforeBetaActivation = await call("mcp_protocol", { server: "remote_beta", action: "resources/read", params: { uri: GUIDE } });
    expect(beforeBetaActivation.isError).toBe(true);
    expect(wire("remote_beta").filter(row => row.method === "resources/read")).toHaveLength(betaReads);
    const singleOriginConsent = confirmations.at(-1)!;
    expect(singleOriginConsent).toMatchObject({ title: "Approve tool use while acting on remote skill?", approved: false });
    expect(singleOriginConsent.message).toContain("Remote skill origins: remote_alpha\n");
    expect(singleOriginConsent.message).toContain('"server":"remote_beta"');
    expect(singleOriginConsent.message).toContain(GUIDE);

    const beta = body(await call("mcp_skills", { action: "load", server: "remote_beta", uri: URI }));
    expect(beta).toMatchObject({ server: "remote_beta", uri: URI });
    expect(beta.content).toContain("REMOTE_BETA_DEMO"); expect(beta.content).not.toContain("REMOTE_ALPHA_DEMO");
    expect(windows()).toEqual([{ server: "remote_alpha", uri: URI }, { server: "remote_beta", uri: URI }]);
    expect(loader.getSkills().skills.map(s => s.filePath)).toEqual([localFile]);
    await local();

    const denied = await call("local_effect", { phase: "blocked" });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied.content)).toContain("Remote skills do not authorize local execution");
    expect(executions).toBe(1); expect(existsSync(forbiddenMarker)).toBe(false);
    const executionConsent = confirmations.at(-1)!;
    expect(executionConsent).toMatchObject({ title: "Approve tool use while acting on remote skill?", approved: false });
    expect(executionConsent.message).toContain("remote_alpha"); expect(executionConsent.message).toContain("remote_beta");
    expect(executionConsent.message).toContain("local_effect");
    const beforeRead = wire("remote_beta").filter(row => row.method === "resources/read").length;
    const crossOrigin = await call("mcp_protocol", { server: "remote_beta", action: "resources/read", params: { uri: GUIDE } });
    expect(crossOrigin.isError).toBe(true);
    expect(JSON.stringify(crossOrigin.content)).not.toContain("remote_beta supporting guide");
    expect(wire("remote_beta").filter(row => row.method === "resources/read")).toHaveLength(beforeRead);
    const readConsent = confirmations.at(-1)!;
    expect(readConsent.approved).toBe(false);
    for (const origin of ["remote_alpha", "remote_beta", GUIDE]) expect(readConsent.message).toContain(origin);
    expect(existsSync(forbiddenMarker)).toBe(false);
  } finally {
    if (session) { await session.abort(); await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
