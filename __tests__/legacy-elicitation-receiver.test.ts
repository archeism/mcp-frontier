import { expect, it } from "vitest";
import { McpServerManager } from "../server-manager.ts";

// Real stdio peer: control forwards requests in the server-to-client direction.
const peer = String.raw`
const rl=require('node:readline').createInterface({input:process.stdin});
const pending=new Map();let id=1000;
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
rl.on('line',line=>{const q=JSON.parse(line);
 if(pending.has(q.id)){const original=pending.get(q.id);pending.delete(q.id);return send({jsonrpc:'2.0',id:original,result:{content:[{type:'text',text:JSON.stringify(q)}]}});}
 const reply=result=>send({jsonrpc:'2.0',id:q.id,result});
 if(q.method==='initialize')return reply({protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'peer',version:'1'}});
 if(q.method==='tools/list')return reply({tools:[{name:'peer',inputSchema:{type:'object',additionalProperties:true}}]});
 if(q.method==='tools/call'){const n=id++;pending.set(n,q.id);return send({jsonrpc:'2.0',id:n,...q.params.arguments});}
 if(q.id!==undefined)send({jsonrpc:'2.0',id:q.id,error:{code:-32601,message:'unsupported'}});
});`;

it("production legacy elicitation receiver gates approval, exposes result/get/list and cancels pending input", async () => {
  const manager = new McpServerManager();
  let release!: (value: string | undefined) => void;
  const prompts: string[] = [];
  manager.setElicitationConfig({ allowUrl: false, ui: {
    select: async title => { prompts.push(title); return new Promise(resolve => { release = resolve; }); },
    input: async () => undefined, notify() {},
  } });
  try {
    const connection = await manager.connect("host-assigned-peer", { command: process.execPath,
      args: ["-e", peer], protocolVersion: "legacy", tasks: true });
    const rpc = async (method: string, params: Record<string, unknown>) => {
      const response = await connection.client.callTool({ name: "peer", arguments: { method, params } });
      return JSON.parse((response.content[0] as { text: string }).text);
    };
    const create = async () => (await rpc("elicitation/create", { mode: "form", message: "Controlled receiver input",
      requestedSchema: { type: "object", properties: {} }, task: { ttl: 60000 } })).result.task;
    const first = await create();
    await expect.poll(() => prompts.length).toBe(1);
    expect(prompts[0]).toContain("host-assigned-peer");
    expect((await rpc("tasks/get", { taskId: first.taskId })).result.status).not.toBe("completed");
    let finished = false;
    const result = rpc("tasks/result", { taskId: first.taskId }).then(value => { finished = true; return value; });
    expect(finished).toBe(false); release("Continue");
    expect((await result).result).toMatchObject({ action: "accept", content: {} });
    expect((await rpc("tasks/get", { taskId: first.taskId })).result.status).toBe("completed");
    expect((await rpc("tasks/list", {})).result.tasks).toEqual(expect.arrayContaining([expect.objectContaining({ taskId: first.taskId })]));
    const declined = await create(); await expect.poll(() => prompts.length).toBe(2); release("Decline");
    expect((await rpc("tasks/result", { taskId: declined.taskId })).result.action).toBe("decline");
    const pending = await create(); await expect.poll(() => prompts.length).toBe(3);
    expect((await rpc("tasks/cancel", { taskId: pending.taskId })).result.status).toBe("cancelled");
    expect((await rpc("tasks/result", { taskId: pending.taskId })).error.message).toMatch(/cancelled/i);
    release("Continue");
    expect((await rpc("tasks/get", { taskId: pending.taskId })).result.status).toBe("cancelled");
  } finally { await manager.closeAll(); }
}, 15000);
