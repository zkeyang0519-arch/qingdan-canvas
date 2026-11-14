import assert from "node:assert/strict";
import path from "node:path";
import net from "node:net";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import * as manager from "../../scripts/lib/agent-install.mjs";

const exec = promisify(execFile);
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(check, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await pause(30);
  }
  assert.fail("isolated launcher did not reach its expected state");
}
async function ports() {
  const servers = [net.createServer(), net.createServer()];
  for (const server of servers)
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const values = servers.map((s) => s.address().port);
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  assert.ok(values.every((port) => port !== 8790 && port !== 8788));
  return values;
}
const portFree = manager.portAvailable;
export async function lifecycleCheckout(t, source) {
  const workspace = process.cwd();
  await mkdir(path.join(workspace, ".tmp"), { recursive: true });
  const root = await mkdtemp(path.join(workspace, ".tmp/lifecycle-child-"));
  const [uiPort, workerPort] = await ports(),
    eventsFile = path.join(root, "events.jsonl");
  await mkdir(path.join(root, "scripts/lib"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "qingdan-canvas",
      type: "module",
      version: "fixture",
      scripts: { "dev:agent": "node scripts/dev-agent.mjs" },
    }),
  );
  await writeFile(
    path.join(root, "scripts/agent.ps1"),
    await readFile(path.join(workspace, "scripts/agent.ps1")),
  );
  await writeFile(
    path.join(root, "scripts/agent-install.mjs"),
    `import ${JSON.stringify(pathToFileURL(path.join(workspace, "scripts/agent-install.mjs")).href)};\n`,
  );
  for (const file of ["dev-agent.mjs", "dev.mjs"]) {
    // Run the actual launcher code. Only fixed loopback ports are substituted.
    const text = await readFile(path.join(workspace, "scripts", file), "utf8");
    await writeFile(
      path.join(root, "scripts", file),
      text
        .replaceAll("8790", String(uiPort))
        .replaceAll("8788", String(workerPort)),
    );
  }
  for (const name of [
    "agent-experience-server",
    "agent-experience-service",
    "stop-child",
    "agent-experience-launcher",
    "local-runner-api",
    "local-desktop-api",
    "desktop-launcher",
    "local-runner-diagnostics",
    "execution-trial",
    "agent-install-bridge",
  ]) {
    await writeFile(
      path.join(root, "scripts/lib", name + ".mjs"),
      `export * from ${JSON.stringify(pathToFileURL(path.join(workspace, "scripts/lib", name + ".mjs")).href)};\n`,
    );
  }
  const mark = `const mark = (event) => fs.appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify({event, at:Date.now(), pid:process.pid})+'\\n');`;
  await writeFile(
    path.join(root, "scripts/build-runner.mjs"),
    `import fs from 'node:fs'; ${mark} mark('build');`,
  );
  for (const name of ["vite", "wrangler"])
    await mkdir(path.join(root, `node_modules/${name}/bin`), {
      recursive: true,
    });
  await writeFile(
    path.join(root, "node_modules/vite/bin/vite.js"),
    "process.exit(0);\n",
  );
  await writeFile(
    path.join(root, "node_modules/wrangler/bin/wrangler.js"),
    `const fs=require('node:fs'), http=require('node:http'); ${mark} if(process.argv[2]!=='dev')process.exit(0); if(!fs.existsSync(${JSON.stringify(path.join(root, "web-allow"))})){mark('web-exit');process.exit(1);} const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({user:null}));});server.listen(${workerPort},'127.0.0.1',()=>mark('web-ready'));`,
  );
  await build({
    stdin: {
      resolveDir: workspace,
      contents: `
      import fs from 'node:fs'; import path from 'node:path'; import { randomUUID } from 'node:crypto';
      import { RunnerDeviceController as RealController } from './runner/device-controller';
      import { DeviceStore } from './runner/device-store';
      import { MemoryCredentialStore, credentialTarget } from './runner/credentials';
      ${mark}
      const stateDir=${JSON.stringify(path.join(root, ".tmp/runner-device"))}, origin=${JSON.stringify(`http://127.0.0.1:${workerPort}`)};
      const store=new DeviceStore(path.join(stateDir,'device.sqlite'));
      let config=store.config(); if(!config){ config={runnerId:randomUUID(),ownerId:'fixture-owner',deviceName:'Fixture',serverOrigin:origin,authEpoch:1,enabled:true,pairingPending:true};store.saveConfig(config); } store.close();
      const credentials=new MemoryCredentialStore(); await credentials.write(credentialTarget(origin,config.runnerId),'fixture-only-secret');
      export class RunnerDeviceController extends RealController {
        constructor(options){super({...options,credentials,locksDir:path.join(stateDir,'fixture-locks'),fetch:async()=>{mark('pair-token');return new Response('{}',{status:503});}});mark('controller-created');fs.writeFileSync(${JSON.stringify(path.join(root, "runner-id"))},config.runnerId);}
        async start(){mark('controller-start');return super.start();}
        async close(){mark('controller-close-begin');await super.close();mark('controller-close-end');}
      }
    `,
    },
    outfile: path.join(root, "runner/dist/index.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    logLevel: "silent",
  });
  const options = {
    root,
    source,
    stateDir: path.join(
      root,
      source ? ".tmp/agent-install-source" : ".tmp/agent-install-test",
    ),
    checkDependencies: false,
    startupTimeoutMs: 300,
    probePort: (port) => portFree(port === 8790 ? uiPort : workerPort),
    probeReady: async () => {
      try {
        return (
          await fetch(`http://127.0.0.1:${uiPort}/api/session`, {
            signal: AbortSignal.timeout(300),
          })
        ).ok;
      } catch {
        return false;
      }
    },
  };
  let child;
  const events = async () => {
    try {
      return (await readFile(eventsFile, "utf8"))
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map(JSON.parse);
    } catch {
      return [];
    }
  };
  t.after(async () => {
    await manager.stop({ ...options, interruptActive: true }).catch(() => {});
    if (child?.exitCode === null && child?.signalCode === null) child.kill();
    await until(
      async () => (await portFree(uiPort)) && (await portFree(workerPort)),
    );
    assert.ok(root.startsWith(path.join(workspace, ".tmp") + path.sep));
    await rm(root, { recursive: true, force: true });
  });
  if (!source) await manager.install(options);
  return {
    options,
    root,
    uiPort,
    workerPort,
    events,
    async launch() {
      if (source) {
        child = spawn(
          process.execPath,
          [path.join(root, "scripts/dev-agent.mjs")],
          { cwd: root, windowsHide: true, stdio: "ignore" },
        );
        return child;
      } else return manager.start(options);
    },
    async recoverCli() {
      const command =
        process.platform === "win32" ? "powershell.exe" : process.execPath;
      const args =
        process.platform === "win32"
          ? [
              "-NoProfile",
              "-NonInteractive",
              "-ExecutionPolicy",
              "Bypass",
              "-File",
              source
                ? path.join(root, "scripts/agent.ps1")
                : path.join(options.stateDir, "agent.ps1"),
              "-Action",
              "recover-web",
              ...(source ? ["-Source"] : []),
            ]
          : [
              path.join(workspace, "scripts/agent-install.mjs"),
              "recover-web",
              "--root",
              root,
              "--state-dir",
              options.stateDir,
              ...(source ? ["--source"] : []),
            ];
      const { stdout } = await exec(command, args, {
        cwd: root,
        windowsHide: true,
        timeout: 5000,
      });
      return JSON.parse(stdout);
    },
  };
}
