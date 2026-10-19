import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Isolated native install: never touches the operator's Pi settings.
const root = mkdtempSync(path.join(tmpdir(), 'mcp-frontier-github-'));
const agentDir = path.join(root, 'agent');
mkdirSync(agentDir);
const source = 'git:github.com/archeism/mcp-frontier';
const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
const installed = spawnSync(process.execPath, [
  path.resolve('node_modules/@earendil-works/pi-coding-agent/dist/cli.js'), 'install', source,
], { cwd: root, env, encoding: 'utf8', timeout: 180000 });
assert.equal(installed.status, 0, installed.stdout + installed.stderr);
const settings = JSON.parse(readFileSync(path.join(agentDir, 'settings.json'), 'utf8'));
assert.ok(settings.packages.some(entry => (typeof entry === 'string' ? entry : entry.source) === source));
const loaded = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '--eval', `
  import assert from 'node:assert/strict';
  const { DefaultResourceLoader, SettingsManager } = await import(${JSON.stringify(import.meta.resolve('@earendil-works/pi-coding-agent'))});
  const loader = new DefaultResourceLoader({ cwd: ${JSON.stringify(root)}, agentDir: ${JSON.stringify(agentDir)},
    settingsManager: SettingsManager.create(${JSON.stringify(root)}, ${JSON.stringify(agentDir)}),
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const extension = loader.getExtensions().extensions.find(e => e.tools.has('mcp_events') && e.tools.has('mcp_skills'));
  assert.ok(extension, 'Git-installed complete extension must register advanced tools');
  console.log(JSON.stringify({status:'passed', source:${JSON.stringify(source)}, entry:extension.path}));
`], { cwd: root, env, encoding: 'utf8', timeout: 60000 });
assert.equal(loaded.status, 0, loaded.stdout + loaded.stderr);
process.stdout.write(loaded.stdout);
console.log(`Isolated installation retained: ${root}`);
