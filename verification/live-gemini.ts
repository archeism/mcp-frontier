import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { hostConfig, skillUri } from "../__tests__/fixtures/pi-host-config.ts";

const require = createRequire(import.meta.url);
const root = await mkdtemp(join(tmpdir(), "pi-real-gemini-"));
const evidence = resolve("../verification-evidence", `live-gemini-${new Date().toISOString().replaceAll(":", "-")}`);
await mkdir(evidence, { recursive: true });
const agentDir = join(root, "agent");
await mkdir(agentDir);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_MCP_CONFIG_MODE = "exclusive";
const sdk = (name: string) => pathToFileURL(require.resolve(name).replace(/\.cjs$/, ".mjs")).href;
const samplingSource = `
import { Server } from ${JSON.stringify(sdk("@modelcontextprotocol/server"))};
import { StdioServerTransport } from ${JSON.stringify(sdk("@modelcontextprotocol/server/stdio"))};
const server = new Server({name:"real-sampling",version:"1"},{capabilities:{tools:{}}});
server.setRequestHandler("tools/list",async()=>({tools:[{name:"sample",inputSchema:{type:"object",properties:{}}}]}));
server.setRequestHandler("tools/call",async()=>({content:[{type:"text",text:JSON.stringify(await server.createMessage({maxTokens:1024,messages:[{role:"user",content:{type:"text",text:"Compute 137 + 286. Reply exactly SAMPLING_REAL_423."}}]}))}]}));
await server.connect(new StdioServerTransport());`;
await writeFile(join(agentDir, "mcp-adapter.json"), JSON.stringify({
  ...hostConfig,
  mcpServers: { ...hostConfig.mcpServers,
    complete: {...hostConfig.mcpServers.complete!,args:[...hostConfig.mcpServers.complete!.args!,`--idle-trigger=${join(root,"trigger")}`]},
    sampling: {command:process.execPath,args:["--input-type=module","--eval",samplingSource],sampling:true,lifecycle:"eager"},
    deepwiki: {url:"https://mcp.deepwiki.com/mcp"},
  },
  settings:{...hostConfig.settings,sampling:true,trace:{enabled:true,file:join(evidence,"mcp-wire.jsonl")}},
}));
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ModelRuntime, initTheme } = await import("@earendil-works/pi-coding-agent");
assert.equal(JSON.parse(await readFile(new URL("../node_modules/@earendil-works/pi-coding-agent/package.json",import.meta.url),"utf8")).version,"1.3.0");
const runtime = await ModelRuntime.create({authPath:join(agentDir,"auth.json"),modelsPath:null,modelsStorePath:join(agentDir,"models.json"),refreshOnCreate:false,allowModelNetwork:false});
await runtime.setRuntimeApiKey("google",(await readFile("/Users/cfeng1/.air/gemini-api-key","utf8")).trim());
const nested: unknown[] = [];
const originalComplete = runtime.complete.bind(runtime);
runtime.complete = async (model,context,options) => {
  const result = await originalComplete(model,context,options);
  nested.push({model:result.model,usage:result.usage,content:result.content.filter(block=>block.type==="text")});
  return result;
};
const settingsManager = SettingsManager.inMemory({compaction:{enabled:false},cacheWarming:"off"});
const loader = new DefaultResourceLoader({cwd:root,agentDir,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,disabledBuiltinExtensions:["mcp"],additionalExtensionPaths:[process.env.PI_MCP_COMPLETE_PACKED_ENTRY ?? resolve("complete.ts")]});
await loader.reload();
assert.deepEqual(loader.getExtensions().errors,[]);
const model=runtime.getModel("google","gemini-3.8-flash");
assert.ok(model);
const { session } = await createAgentSession({cwd:root,agentDir,modelRuntime:runtime,model,thinkingLevel:"off",resourceLoader:loader,settingsManager,sessionManager:SessionManager.inMemory(root),noTools:"builtin"});
const events: string[] = [];
const approvals: unknown[] = [];
const errors: unknown[] = [];
session.subscribe(event=>{events.push(event.type);if(event.type==="tool_execution_start") console.log("TOOL",event.toolName,JSON.stringify(event.args));});
initTheme("dark",false);
await session.bindExtensions({mode:"tui",uiContext:{...session.extensionRunner.getUIContext(),confirm:async(title,message)=>{approvals.push({title,message});return true;},select:async(_title,choices)=>choices[0],input:async()=>"fixture",notify(){}},onError:error=>errors.push(error)});
const started=Date.now();
let passed=false;
const timeout=setTimeout(()=>{void session.abort();},180000);
try {
  await session.prompt('Use MCP tools to execute each operation, not explain: complete server echo, then task; mcp_protocol resources/read fixture://readme; mcp_protocol prompts/get name greet; mcp_skills load URI '+skillUri+' from complete. Finally call sample tool on sampling server. Stop if any fails.');
  const results=session.messages.filter(message=>message.role==="toolResult");
  assert.equal(results.filter(message=>message.isError).length,0,JSON.stringify(results));
  const text=JSON.stringify(results);
  for(const expected of ["fixture echo","task done","fixture resource","fixture prompt",skillUri,"SAMPLING_REAL_423"]) assert.ok(text.includes(expected),`Missing ${expected}`);
  assert.ok(nested.length>0,"No real nested sampling model call");
  await session.prompt('Use mcp to call read_wiki_structure on deepwiki with repoName modelcontextprotocol/typescript-sdk. You may discover the tool first. Report one returned page title.');
  const publicResults=session.messages.filter(message=>message.role==="toolResult");
  assert.ok(publicResults.some(message=>message.toolName.startsWith("mcp")&&!message.isError&&JSON.stringify(message.content).includes("Available pages for modelcontextprotocol/typescript-sdk")),"Missing public server structure");
  assert.deepEqual(errors,[]);
  await session.prompt('Subscribe to tick events on complete using mcp_events. Do not arm any timer. Finish this turn after subscribing. When a later event arrives, acknowledge its requested marker.');
  assert.equal(session.isStreaming,false);
  const idleStarts=events.filter(type=>type==="agent_start").length;
  await writeFile(join(root,"trigger"),"trigger after idle");
  const deadline=Date.now()+45000;
  while(Date.now()<deadline && !(events.filter(type=>type==="agent_start").length>idleStarts && !session.isStreaming && JSON.stringify(session.messages.at(-1)).includes("GEMINI_EVENT_AWAKE"))) await new Promise(resolve=>setTimeout(resolve,100));
  assert.ok(events.filter(type=>type==="agent_start").length>idleStarts,"Event did not start a real agent turn");
  assert.ok(JSON.stringify(session.messages.at(-1)).includes("GEMINI_EVENT_AWAKE"),"Gemini did not acknowledge idle event");
  passed=true;
} finally {
  clearTimeout(timeout);
  await session.abort();
  const messages=session.messages.map(message=>message.role==="assistant"?{...message,content:message.content.map(block=>{const {textSignature, ...rest}=block as any;return rest;})}:message);
  await writeFile(join(evidence,"result.json"),JSON.stringify({passed,provider:"google",model:"gemini-3.8-flash",pi:"1.3.0",elapsedMs:Date.now()-started,maxRSS:process.resourceUsage().maxRSS,nested,approvals,errors,events,messages},null,2));
  await session.extensionRunner.emit({type:"session_shutdown",reason:"quit"});
  session.dispose();
  console.log(JSON.stringify({passed,evidence,elapsedMs:Date.now()-started,nestedCalls:nested.length}));
}
