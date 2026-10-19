import crossSpawn from "cross-spawn";

const args = process.argv.slice(2);

function run(script, scriptArgs = []) {
  const commandArgs = ["run", script];
  if (scriptArgs.length > 0) commandArgs.push("--", ...scriptArgs);
  const result = crossSpawn.sync("bun", commandArgs, { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  return process.exitCode === 0;
}

if (args.length > 0) {
  run("test:vitest", args);
} else if (
  run("test:vitest", ["--exclude", "__tests__/ui-server-browser.test.ts", "--exclude", "__tests__/native-codemode-apps.test.ts"]) &&
  run("test:vitest", ["__tests__/ui-server-browser.test.ts", "__tests__/native-codemode-apps.test.ts", "--maxWorkers=1"])
) {
  run("test:public-exports");
}
