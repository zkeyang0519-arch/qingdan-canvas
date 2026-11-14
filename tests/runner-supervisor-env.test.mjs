import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const exec = promisify(execFile);

for (const explicit of [false, true]) test(`supervisor isolates desktop Core routing in ${explicit ? "explicit" : "inherited"} child environment`, async t => {
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  const dir = await mkdtemp(path.join(root, ".tmp/supervisor-env-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const probePath = path.join(dir, "observed.jsonl");
  await build({ stdin: { contents: "export { CodexSupervisor } from './runner/supervisor.ts';", resolveDir: root }, bundle: true, platform: "node", format: "esm", packages: "external", outfile: path.join(dir, "supervisor.mjs"), logLevel: "silent" });
  await writeFile(path.join(dir, "child.mjs"), `
    import { appendFileSync } from 'node:fs';
    const observed = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(CODEX_WINDOWS_REGISTERED_CORE|CODEX_HOME|CODEX_APP_RUNTIME_CLI_PATH|QINGDAN_ENV_PROBE)$/i.test(key)));
    appendFileSync(process.env.ENV_PROBE_PATH, JSON.stringify({ phase: process.argv.includes('--version') ? 'version' : 'server', env: observed }) + '\\n');
    if (process.argv.includes('--version')) console.log('codex-cli 0.167.0-alpha.4.1');
    else { console.log('ready'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); }
  `);
  await writeFile(path.join(dir, "parent.mjs"), `
    import { CodexSupervisor } from './supervisor.mjs';
    import { once } from 'node:events';
    const explicit = ${explicit};
    const source = explicit ? { ...process.env, QINGDAN_ENV_PROBE: 'explicit' } : undefined;
    if (source) { delete source.CODEX_WINDOWS_REGISTERED_CORE; source.codex_windows_registered_core = '1'; }
    const before = JSON.stringify(source ?? process.env);
    const supervisor = new CodexSupervisor({ command: process.execPath, args: [${JSON.stringify(path.join(dir, 'child.mjs'))}], ...(explicit ? { env: source } : {}) });
    try {
      const child = await supervisor.start();
      await once(child.stdout, 'data');
      console.log(JSON.stringify({ unchanged: before === JSON.stringify(source ?? process.env) }));
    } finally { await supervisor.stop(); }
  `);
  const result = await exec(process.execPath, [path.join(dir, "parent.mjs")], {
    env: { ...process.env, ENV_PROBE_PATH: probePath, CODEX_WINDOWS_REGISTERED_CORE: "1", CODEX_HOME: path.join(dir, "auth-location-preserved"), CODEX_APP_RUNTIME_CLI_PATH: "preserve-unrelated-runtime", QINGDAN_ENV_PROBE: "inherited" },
    windowsHide: true,
  });
  assert.equal(JSON.parse(result.stdout).unchanged, true, "the parent/supplied environment is not mutated");
  const observed = (await readFile(probePath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(observed.map(item => item.phase), ["version", "server"]);
  for (const { env } of observed) {
    assert.equal(Object.keys(env).some(key => key.toUpperCase() === "CODEX_WINDOWS_REGISTERED_CORE"), false, "the child must not inherit desktop-only Core routing");
    assert.equal(env.CODEX_HOME, path.join(dir, "auth-location-preserved"));
    assert.equal(env.CODEX_APP_RUNTIME_CLI_PATH, "preserve-unrelated-runtime");
    assert.equal(env.QINGDAN_ENV_PROBE, explicit ? "explicit" : "inherited");
  }
});
