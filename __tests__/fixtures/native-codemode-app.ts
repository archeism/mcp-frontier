import { App, PostMessageTransport } from "../../examples/interactive-visualizer/node_modules/@modelcontextprotocol/ext-apps/dist/src/app.js";

const state = { initialized: false, input: null as unknown, result: null as unknown, actions: [] as unknown[], errors: [] as string[] };
const render = () => { document.querySelector("#fixture-state")!.textContent = JSON.stringify(state); };
const app = new App({ name: "native-codemode-app", version: "1" });
app.ontoolinput = input => { state.input = input; render(); };
app.ontoolresult = result => { state.result = result; render(); };
for (const phase of ["allow", "deny", "cross"]) document.querySelector(`#${phase}`)!.addEventListener("click", async () => {
  try {
    const result = await app.callServerTool({ name: phase === "cross" ? "decoy_only" : "action",
      arguments: { phase, server: "decoy" } });
    state.actions.push({ phase, result });
  } catch (error) { state.actions.push({ phase, error: String(error) }); }
  render();
});
render();
void app.connect(new PostMessageTransport(window.parent, window.parent)).then(() => {
  state.initialized = true; render();
}).catch(error => { state.errors.push(String(error)); render(); });
