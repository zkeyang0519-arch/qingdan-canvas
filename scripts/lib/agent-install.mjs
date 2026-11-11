import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  randomBytes,
  randomUUID,
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  writeFile,
  rename,
  unlink,
  realpath,
  lstat,
  open,
} from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, lstatSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  knownNeverCreatedExecutor,
  safeStatePath,
  relocatedLedger,
  withRelocationEvidence,
} from "./agent-relocation.mjs";

const exec = promisify(execFile);
const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
const bridge = fileURLToPath(
  new URL("./agent-install-bridge.mjs", import.meta.url),
);
const cli = fileURLToPath(new URL("../agent-install.mjs", import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const samePath = (a, b) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const json = async (file) => {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw Error(`Unreadable installation metadata: ${path.basename(file)}`);
  }
};
async function save(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temp, file);
}
export function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}
export async function locations(options = {}) {
  const root = options.root || sourceRoot;
  if (!path.isAbsolute(root)) throw Error("Project root must be absolute.");
  const projectRoot = await realpath(root);
  const stateDir =
    options.stateDir ||
    path.join(
      projectRoot,
      options.source ? ".tmp/agent-install-source" : ".tmp/agent-install",
    );
  if (!path.isAbsolute(stateDir))
    throw Error("Installation directory must be absolute.");
  const requested = path.resolve(stateDir);
  if (
    !samePath(path.dirname(requested), path.join(projectRoot, ".tmp")) ||
    !/^agent-install(?:-[a-z0-9-]+)?$/i.test(path.basename(requested))
  )
    throw Error(
      "Unsafe installation directory: use an immediate .tmp/agent-install[-name] directory in this checkout.",
    );
  const resolved = path.join(projectRoot, ".tmp", path.basename(requested));
  for (const dir of [path.join(projectRoot, ".tmp"), resolved]) {
    try {
      if (
        (await lstat(dir)).isSymbolicLink() ||
        !samePath(await realpath(dir), dir)
      )
        throw Error(
          "Unsafe installation directory: links and junctions are not allowed.",
        );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return {
    projectRoot,
    stateDir: resolved,
    ...(options.source ? { source: true } : {}),
  };
}
async function protectDirectory(stateDir) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    const { stdout } = await exec(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
      ],
      { windowsHide: true },
    );
    const sid = stdout.trim();
    if (!/^S-1-[0-9-]+$/.test(sid))
      throw Error("Cannot identify the current Windows user.");
    await exec(
      "icacls.exe",
      [
        stateDir,
        "/inheritance:r",
        "/grant:r",
        `*${sid}:(OI)(CI)F`,
        "*S-1-5-18:(OI)(CI)F",
      ],
      { windowsHide: true },
    );
  }
}
export async function preflight(projectRoot) {
  const pin = await json(
    path.join(projectRoot, "runner/protocol-version.json"),
  );
  const requiredNode = Math.max(24, Number(pin?.nodeMajor) || 24);
  if (Number(process.versions.node.split(".")[0]) < requiredNode)
    throw Error(
      `Local Agent requires Node.js >=${requiredNode}; current version is ${process.versions.node}.`,
    );
  await access(
    path.join(projectRoot, "node_modules/wrangler/bin/wrangler.js"),
  ).catch(() => {
    throw Error("Dependencies are missing. Run npm ci in this checkout first.");
  });
  let codex = process.env.QINGDAN_CODEX_BIN;
  if (!codex) {
    if (process.platform === "win32") {
      const result = await exec("where.exe", ["codex.exe"], {
        windowsHide: true,
      });
      codex = result.stdout.trim().split(/\r?\n/)[0];
    } else codex = "codex";
  }
  const { stdout } = await exec(codex, ["--version"], {
    windowsHide: true,
    timeout: 10000,
  });
  const version = stdout.trim().replace(/^codex(?:-cli)?\s+/, "");
  if (version !== pin.codexVersion)
    throw Error(
      `Codex CLI version mismatch: requires ${pin.codexVersion}; found ${version}.`,
    );
  return {
    nodeVersion: process.versions.node,
    codexVersion: version,
    codexPath: codex,
  };
}
function controlDirectories(projectRoot) {
  const base = path.join(projectRoot, ".tmp");
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => /^agent-install(?:-[a-z0-9-]+)?$/i.test(entry.name))
    .map((entry) => {
      const dir = path.join(base, entry.name);
      safeStatePath(projectRoot, dir, "directory");
      return dir;
    });
}
async function assertNoPendingRepair(projectRoot) {
  for (const directory of controlDirectories(projectRoot)) {
    const migration = await json(path.join(directory, "relocation.json"));
    if (migration && migration.plan?.phase !== "complete")
      throw Error(
        "Relocation repair is incomplete. Run repair --relocate before starting or changing any launcher in this checkout.",
      );
  }
}
async function manifestAt(loc) {
  await assertNoPendingRepair(loc.projectRoot);
  const manifest = await json(
    path.join(loc.stateDir, loc.source ? "source.json" : "install.json"),
  );
  if (!manifest)
    throw Error("Local Agent is not installed. Run the install command first.");
  if (
    manifest.version !== 1 ||
    manifest.projectRoot !== loc.projectRoot ||
    manifest.stateDir !== loc.stateDir ||
    !/^[a-f0-9-]{36}$/.test(manifest.installationId)
  )
    throw Error("Installation identity does not match this checkout.");
  return manifest;
}
async function writeEntryPoint(manifest, entryCli = cli) {
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const entryPoint = path.join(manifest.stateDir, "agent.ps1");
  await writeFile(
    entryPoint,
    `\uFEFF[CmdletBinding()]\nparam(\n  [ValidateSet('install','start','stop','restart','diagnose','uninstall','repair','recover-web')]\n  [string]$Action = 'diagnose',\n  [switch]$InterruptActive,\n  [switch]$Relocate\n)\n$ErrorActionPreference = 'Stop'\n$AgentArgs = @(${quote(entryCli)}, $Action, '--root', ${quote(manifest.projectRoot)}, '--state-dir', ${quote(manifest.stateDir)})\nif ($InterruptActive) { $AgentArgs += '--interrupt-active' }\nif ($Relocate) { $AgentArgs += '--relocate' }\n& ${quote(manifest.nodePath)} @AgentArgs\nexit $LASTEXITCODE\n`,
    { mode: 0o600 },
  );
  return entryPoint;
}
export async function install(options = {}) {
  if (options.source)
    throw Error(
      "Source mode is registered by dev-agent; it is not an installation.",
    );
  const loc = await locations(options);
  const pkg = await json(path.join(loc.projectRoot, "package.json"));
  if (
    pkg?.name !== "qingdan-canvas" ||
    pkg.scripts?.["dev:agent"] !== "node scripts/dev-agent.mjs"
  )
    throw Error("This is not the expected qingdan-canvas checkout.");
  const versions =
    options.checkDependencies === false ? {} : await preflight(loc.projectRoot);
  await protectDirectory(loc.stateDir);
  return lock(loc, async () => {
    await assertNoPendingRepair(loc.projectRoot);
    const previous = await json(path.join(loc.stateDir, "install.json"));
    if (previous) await manifestAt(loc);
    const secretFile = path.join(loc.stateDir, "control.key");
    try {
      await writeFile(secretFile, randomBytes(32).toString("hex"), {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    await readControlSecret(loc.stateDir);
    const manifest = {
      version: 1,
      ...loc,
      installationId: previous?.installationId || randomUUID(),
      nodePath: process.execPath,
      ...versions,
      installedAt: previous?.installedAt || new Date().toISOString(),
    };
    const entryPoint = await writeEntryPoint(manifest);
    await save(path.join(loc.stateDir, "install.json"), manifest);
    return {
      installed: true,
      projectRoot: loc.projectRoot,
      stateDir: loc.stateDir,
      entryPoint,
      nodeVersion: process.versions.node,
      codexVersion: versions.codexVersion || null,
      dataRetained: true,
    };
  });
}

// Source mode has the same private secret and signed protocol as installation,
// but creates no install.json, entry script, OS service or startup registration.
export async function withSourceManifest(options, work) {
  const loc = await locations({ ...options, source: true });
  await protectDirectory(loc.stateDir);
  return lock(loc, async () => {
    await assertNoPendingRepair(loc.projectRoot);
    const secretFile = path.join(loc.stateDir, "control.key");
    try {
      await writeFile(secretFile, randomBytes(32).toString("hex"), {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    await readControlSecret(loc.stateDir);
    let manifest = await json(path.join(loc.stateDir, "source.json"));
    if (manifest) await manifestAt(loc);
    else {
      manifest = {
        version: 1,
        ...loc,
        installationId: randomUUID(),
        nodePath: process.execPath,
      };
      await save(path.join(loc.stateDir, "source.json"), manifest);
    }
    const runtime = await json(path.join(loc.stateDir, "runtime.json"));
    try {
      await requestControl(manifest, "status");
      throw Error("This source launcher is already running.");
    } catch (error) {
      if (
        error.code !== "CONTROL_ABSENT" ||
        (runtime &&
          (!Number.isSafeInteger(runtime.pid) || processExists(runtime.pid)))
      )
        throw error;
    }
    manifest = { ...manifest, nodePath: process.execPath };
    await save(path.join(loc.stateDir, "source.json"), manifest);
    return work(manifest);
  });
}

export async function recoverWeb(options = {}) {
  const loc = await locations(options),
    manifest = await manifestAt(loc);
  return lock(loc, () => requestControl(manifest, "recover-web"));
}

async function verifyOldInstanceAbsent(manifest, stateDir) {
  const runtime = await json(path.join(stateDir, "runtime.json"));
  // A live PID is never treated as dead merely because authentication failed.
  if (
    runtime &&
    (!Number.isSafeInteger(runtime.pid) ||
      runtime.pid < 1 ||
      processExists(runtime.pid))
  )
    throw Error(
      "A live or unverified process occupies the old runtime identity; relocation was refused.",
    );
  try {
    await requestControl(manifest, "status", { identityStateDir: stateDir });
    throw Error(
      "The old managed instance is still running; stop it before relocation.",
    );
  } catch (error) {
    if (error.code !== "CONTROL_ABSENT") throw error;
  }
  return runtime;
}

export async function repair(options = {}) {
  if (options.relocate !== true)
    throw Error("Repair requires explicit --relocate.");
  const loc = await locations(options);
  return lock(loc, async () => {
    const secret = await readControlSecret(loc.stateDir);
    const planFile = path.join(loc.stateDir, "relocation.json");
    const saved = await json(planFile);
    if (saved && !signatureMatches(secret, saved.plan, saved.proof))
      throw Error(
        "Relocation repair record cannot be verified; retain it for inspection.",
      );
    let plan = saved?.plan;
    if (plan?.phase === "complete" && plan.to === loc.projectRoot) {
      await manifestAt(loc);
      return { repaired: true, alreadyRepaired: true, ...loc };
    }
    if (plan?.phase === "complete") plan = null;
    const manifestFile = path.join(
      loc.stateDir,
      loc.source ? "source.json" : "install.json",
    );
    const old = plan?.oldManifest || (await json(manifestFile));
    if (
      !old ||
      old.version !== 1 ||
      !path.isAbsolute(old.projectRoot || "") ||
      !path.isAbsolute(old.stateDir || "") ||
      !/^[a-f0-9-]{36}$/.test(old.installationId) ||
      !samePath(
        old.stateDir,
        path.join(old.projectRoot, ".tmp", path.basename(loc.stateDir)),
      )
    )
      throw Error("Invalid old installation identity; relocation was refused.");
    if (samePath(old.projectRoot, loc.projectRoot))
      throw Error(
        "This installation has not moved; use install to update dependencies.",
      );
    try {
      await lstat(old.projectRoot);
      throw Error(
        "The old checkout still exists; a copy is not a relocation. No data was changed.",
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (
      plan &&
      (plan.to !== loc.projectRoot ||
        plan.stateDir !== loc.stateDir ||
        plan.from !== old.projectRoot)
    )
      throw Error("Relocation repair belongs to another destination.");
    const runtime = await verifyOldInstanceAbsent(old, loc.stateDir);
    // Source and installed entries share application/execution state. Check all
    // retained local identities, including one whose runtime record disappeared.
    for (const directory of controlDirectories(loc.projectRoot)) {
      for (const filename of ["install.json", "source.json"]) {
        const other = await json(path.join(directory, filename));
        if (
          !other ||
          (directory === loc.stateDir &&
            filename === path.basename(manifestFile))
        )
          continue;
        if (
          ![old.projectRoot, loc.projectRoot].includes(other.projectRoot) ||
          !samePath(
            other.stateDir,
            path.join(other.projectRoot, ".tmp", path.basename(directory)),
          )
        )
          throw Error(
            "Another local control identity cannot be verified; relocation was refused.",
          );
        await verifyOldInstanceAbsent(other, directory);
      }
    }
    // Relocation uses the full evidence gate below. The ordinary stop summary
    // cannot distinguish a never-created executor from a lost native journal.
    const savePlan = async () =>
      save(planFile, { plan, proof: signature(secret, plan) });
    return withRelocationEvidence(loc.projectRoot, options, async () => {
      // Validate terminal native evidence on every retry, not only the first one.
      const ledger = relocatedLedger(loc.projectRoot, old.projectRoot);
      if (!plan) {
        const versions =
          options.checkDependencies === false
            ? {}
            : await preflight(loc.projectRoot);
        plan = {
          version: 1,
          phase: "prepared",
          from: old.projectRoot,
          to: loc.projectRoot,
          stateDir: loc.stateDir,
          oldManifest: old,
          newManifest: {
            ...old,
            ...loc,
            nodePath: process.execPath,
            ...versions,
          },
          ledger,
          runtime,
        };
        await savePlan();
      }
      const ledgerFile = path.join(
        loc.projectRoot,
        ".tmp/agent-experience/sessions.json",
      );
      if (plan.ledger) {
        if (
          !ledger ||
          ![
            JSON.stringify(plan.ledger.before),
            JSON.stringify(plan.ledger.after),
          ].includes(JSON.stringify(ledger.before))
        )
          throw Error(
            "Experience evidence changed during relocation repair; no records were overwritten.",
          );
        await save(ledgerFile, plan.ledger.after);
      } else if (ledger)
        throw Error("Experience evidence appeared during relocation repair.");
      plan.phase = "ledger";
      await savePlan();
      const currentManifest = await json(manifestFile);
      if (
        ![
          JSON.stringify(plan.oldManifest),
          JSON.stringify(plan.newManifest),
        ].includes(JSON.stringify(currentManifest))
      )
        throw Error("Installation identity changed during relocation repair.");
      await save(manifestFile, plan.newManifest);
      plan.phase = "manifest";
      await savePlan();
      // The entry must reference the relocated checkout, not the importing CLI.
      if (!loc.source)
        await writeEntryPoint(
          plan.newManifest,
          path.join(loc.projectRoot, "scripts/agent-install.mjs"),
        );
      plan.phase = "entry";
      await savePlan();
      const runtimeFile = path.join(loc.stateDir, "runtime.json");
      const currentRuntime = await json(runtimeFile);
      if (
        currentRuntime &&
        JSON.stringify(currentRuntime) !== JSON.stringify(plan.runtime)
      )
        throw Error("Runtime identity changed during relocation repair.");
      if (currentRuntime) await unlink(runtimeFile);
      plan.phase = "complete";
      await savePlan();
      return {
        repaired: true,
        dataRetained: true,
        ...loc,
        ...(!loc.source
          ? { entryPoint: path.join(loc.stateDir, "agent.ps1") }
          : {}),
      };
    });
  });
}
export function pipeAddress(manifest) {
  const key = createHash("sha256")
    .update(`${manifest.projectRoot}\0${manifest.installationId}`)
    .digest("hex")
    .slice(0, 32);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\qingdan-agent-${key}`
    : path.join(manifest.stateDir, "control.sock");
}
export function signature(secret, value) {
  return createHmac("sha256", secret)
    .update(JSON.stringify(value))
    .digest("hex");
}
export function signatureMatches(secret, value, proof) {
  if (typeof proof !== "string" || !/^[a-f0-9]{64}$/.test(proof)) return false;
  return timingSafeEqual(
    Buffer.from(signature(secret, value), "hex"),
    Buffer.from(proof, "hex"),
  );
}
export async function readControlSecret(stateDir) {
  const secret = await readFile(path.join(stateDir, "control.key"), "utf8");
  if (secret.length !== 64 || /[^a-f0-9]/.test(secret))
    throw Error(
      "Invalid installation control key: expected exactly 64 lowercase hexadecimal characters. The existing file was retained; do not replace a running instance's key.",
    );
  return secret;
}
export async function requestControl(manifest, command, options = {}) {
  // Relocation reads the retained metadata at its new location, while still
  // authenticating the old endpoint and old project identity.
  const metadataDir = options.identityStateDir || manifest.stateDir;
  const secret = await readControlSecret(metadataDir);
  const expected = await json(path.join(metadataDir, "runtime.json"));
  const challenge = randomBytes(32).toString("hex");
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipeAddress(manifest));
    const timer = setTimeout(
      () => finish(Error("Managed instance control timed out.")),
      3000,
    );
    let buffer = "",
      phase = "hello",
      identity;
    function finish(error, result) {
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve(result);
    }
    socket.once("connect", () =>
      socket.write(`${JSON.stringify({ challenge })}\n`),
    );
    socket.once("error", (error) =>
      finish(
        Object.assign(
          Error("Managed instance identity could not be verified."),
          {
            code: ["ENOENT", "ECONNREFUSED"].includes(error.code)
              ? "CONTROL_ABSENT"
              : "CONTROL_UNVERIFIED",
          },
        ),
      ),
    );
    socket.once("end", () => {
      if (phase !== "done")
        finish(
          Error("Managed instance closed control without a verified response."),
        );
    });
    socket.on("data", (data) => {
      buffer += data.toString();
      if (buffer.length > 32768)
        return finish(Error("Invalid control response."));
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try {
          const response = JSON.parse(line);
          if (phase === "hello") {
            identity = response.identity;
            if (
              !signatureMatches(
                secret,
                ["server", challenge, identity],
                response.proof,
              ) ||
              identity.projectRoot !== manifest.projectRoot ||
              identity.installationId !== manifest.installationId ||
              (expected &&
                (identity.pid !== expected.pid ||
                  identity.instanceId !== expected.instanceId))
            )
              throw Error("Managed instance identity mismatch.");
            phase = "result";
            const payload = {
              command,
              interruptActive: options.interruptActive === true,
            };
            socket.write(
              `${JSON.stringify({ payload, proof: signature(secret, ["client", challenge, identity, payload]) })}\n`,
            );
          } else if (phase === "result") {
            if (
              !signatureMatches(
                secret,
                ["result", challenge, identity, response.result],
                response.proof,
              )
            )
              throw Error("Managed instance response identity mismatch.");
            phase = "done";
            if (response.result.error) finish(Error(response.result.error));
            else finish(null, response.result);
          }
        } catch (error) {
          finish(error);
        }
      }
    });
  });
}
async function portAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}
async function applicationReady() {
  try {
    const response = await fetch("http://127.0.0.1:8790/api/session", {
      signal: AbortSignal.timeout(1000),
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      return false;
    }
    const session = await response.json();
    return (
      session !== null &&
      typeof session === "object" &&
      Object.hasOwn(session, "user")
    );
  } catch {
    return false;
  }
}
async function readiness(control, options) {
  const ready =
    !control.stopping && (await (options.probeReady || applicationReady)());
  return {
    ...control,
    ready,
    status: control.stopping
      ? "stopping"
      : control.web?.phase === "recovery_required"
        ? "recovery_required"
        : ready
          ? "running"
          : "starting",
  };
}
async function lock(loc, work) {
  // SQLite holds an OS-backed write reservation for the whole operation.
  // Closing this connection (including process death) releases only its own
  // reservation; no PID record, stale-file unlink, or owner-check TOCTOU exists.
  // Keep operation.sqlite in place: deleting it would create competing locks.
  const { DatabaseSync } = await import("node:sqlite");
  let db, checkoutLock;
  try {
    try {
      const globalFile = path.join(
        loc.projectRoot,
        ".tmp/agent-lifecycle.sqlite",
      );
      safeStatePath(loc.projectRoot, globalFile);
      checkoutLock = new DatabaseSync(globalFile);
      checkoutLock.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
      db = new DatabaseSync(path.join(loc.stateDir, "operation.sqlite"));
      db.exec("PRAGMA busy_timeout = 0");
      db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      // Include extended SQLite BUSY/LOCKED codes, without hiding filesystem
      // permission, disk, corruption, or other initialization failures.
      if ([5, 6].includes(error.errcode & 0xff))
        throw Error(
          "Another lifecycle operation is in progress; retry when it completes.",
        );
      throw error;
    }
    try {
      return await work();
    } finally {
      db.exec("ROLLBACK");
    }
  } finally {
    db?.close();
    checkoutLock?.close();
  }
}
export async function start(options = {}) {
  if (options.source)
    throw Error(
      "Start source mode with npm run dev; use recover-web --source for its existing web child.",
    );
  const loc = await locations(options);
  const manifest = await manifestAt(loc);
  return lock(loc, async () => {
    await readControlSecret(loc.stateDir);
    const runtime = await json(path.join(loc.stateDir, "runtime.json"));
    if (runtime) {
      try {
        return {
          ...(await readiness(
            await requestControl(manifest, "status"),
            options,
          )),
          alreadyRunning: true,
        };
      } catch {
        if (processExists(runtime.pid))
          throw Error(
            "Unverified or foreign process occupies the runtime identity; no process was changed.",
          );
      }
    }
    const probePort = options.probePort || portAvailable;
    if (!(await probePort(8790)) || !(await probePort(8788)))
      throw Error(
        "Local ports 8790/8788 are occupied by an unmanaged service. Stop that original launcher explicitly before starting the installed Agent.",
      );
    const logfile = await open(
      path.join(loc.stateDir, "service.log"),
      "a",
      0o600,
    );
    const env = {
      ...process.env,
      QINGDAN_AGENT_INSTALL_DIR: loc.stateDir,
      QINGDAN_AGENT_PROJECT_ROOT: loc.projectRoot,
      NODE_OPTIONS:
        `${process.env.NODE_OPTIONS || ""} --import=${pathToFileURL(bridge).href}`.trim(),
      ...(manifest.codexPath ? { QINGDAN_CODEX_BIN: manifest.codexPath } : {}),
    };
    // The checked dev:agent script is exactly this command. Avoid npm/cmd
    // intermediaries so the owned process is the launcher and stays hidden.
    const child = spawn(
      manifest.nodePath,
      [path.join(loc.projectRoot, "scripts/dev-agent.mjs")],
      {
        cwd: loc.projectRoot,
        env,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", logfile.fd, logfile.fd],
      },
    );
    let spawnError;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.unref();
    await logfile.close();
    const deadline = Date.now() + (options.startupTimeoutMs ?? 60000);
    let confirmed;
    do {
      if (spawnError)
        throw Error("Could not launch the installed Node executable.");
      if (child.exitCode !== null || child.signalCode !== null)
        throw Error(
          "Local Agent exited while starting. Run diagnose and inspect the local service.log.",
        );
      try {
        const response = await readiness(
          await requestControl(manifest, "status"),
          options,
        );
        confirmed = {
          ...response,
          alreadyRunning: false,
          logPath: path.join(loc.stateDir, "service.log"),
        };
        if (response.ready) return confirmed;
      } catch {
        /* The launcher and its control bridge are still starting. */
      }
      await pause(100);
    } while (Date.now() < deadline);
    if (child.exitCode !== null || child.signalCode !== null)
      throw Error(
        "Local Agent exited while starting. Run diagnose and inspect the local service.log.",
      );
    if (confirmed) return { ...confirmed, ready: false };
    throw Error(
      "Local Agent startup was not confirmed. Run diagnose before retrying; no process was killed.",
    );
  });
}
export async function stop(options = {}) {
  const loc = await locations(options);
  const manifest = await manifestAt(loc);
  return lock(loc, async () => {
    const runtimeFile = path.join(loc.stateDir, "runtime.json");
    const runtime = await json(runtimeFile);
    if (!runtime) return { stopped: true, alreadyStopped: true };
    if (!processExists(runtime.pid)) {
      await unlink(runtimeFile);
      return { stopped: true, staleRecordRemoved: true };
    }
    const response = await requestControl(manifest, "stop", options);
    for (let attempt = 0; attempt < 450; attempt++) {
      const current = await json(runtimeFile);
      if (!current || !processExists(runtime.pid))
        return {
          stopped: true,
          interruptedActive: response.interruptedActive === true,
        };
      if (current.instanceId !== runtime.instanceId)
        throw Error(
          "Instance changed while stopping; no further action was taken.",
        );
      await pause(100);
    }
    throw Error(
      "Graceful stop is still pending. Inspect diagnose/logs; no force kill was attempted.",
    );
  });
}
export async function uninstall(options = {}) {
  if (options.source)
    throw Error("Source lifecycle metadata is not an installation.");
  const loc = await locations(options);
  return lock(loc, async () => {
    const manifest = await manifestAt(loc);
    const runtime = await json(path.join(loc.stateDir, "runtime.json"));
    if (runtime && processExists(runtime.pid))
      throw Error(
        "Stop the managed Agent before uninstalling. Data and credentials were retained.",
      );
    // No recursive deletion and no remote revoke, credential deletion, or data cleanup.
    await unlink(path.join(manifest.stateDir, "agent.ps1")).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await unlink(path.join(manifest.stateDir, "install.json"));
    return {
      uninstalled: true,
      dataRetained: true,
      logsRetained: true,
      credentialsRetained: true,
      retainedDirectory: loc.stateDir,
    };
  });
}
export async function diagnose(options = {}) {
  const loc = await locations(options);
  const present = await json(
    path.join(loc.stateDir, loc.source ? "source.json" : "install.json"),
  );
  if (!present) return { installed: false, status: "not_installed", ...loc };
  const manifest = await manifestAt(loc);
  const runtime = await json(path.join(loc.stateDir, "runtime.json"));
  let status = "stopped",
    control;
  if (runtime) {
    try {
      control = await readiness(
        await requestControl(manifest, "status"),
        options,
      );
      status = control.status;
    } catch {
      status = processExists(runtime.pid) ? "unverified" : "stale";
    }
  }
  const probePort = options.probePort || portAvailable;
  const ports = {
    experience: !(await probePort(8790)),
    application: !(await probePort(8788)),
  };
  if (status === "stopped" && (ports.experience || ports.application))
    status = "unmanaged";
  return {
    installed: true,
    status,
    ready: control?.ready === true,
    ...loc,
    nodeVersion: process.versions.node,
    requiredNodeMajor: 24,
    codexVersion: manifest.codexVersion || null,
    ports,
    ...(control
      ? {
          pid: control.pid,
          instanceId: control.instanceId,
          active: control.active,
          ...(control.web ? { web: control.web } : {}),
        }
      : {}),
    logPath: path.join(loc.stateDir, "service.log"),
    retainedData: [
      ".tmp/runner-device",
      ".tmp/agent-experience",
      ".wrangler",
      "Windows Credential Manager",
    ],
  };
}

// Read only known local state; never follow registered workspaces or expose their contents.
export async function inspectActive(projectRoot) {
  const unknown = [],
    active = [];
  const base = path.join(projectRoot, ".tmp");
  const safe = (file) => {
    if (!file.startsWith(`${base}${path.sep}`)) return false;
    let next = base;
    for (const piece of path.relative(base, file).split(path.sep)) {
      next = path.join(next, piece);
      if (existsSync(next) && lstatSync(next).isSymbolicLink()) return false;
    }
    return true;
  };
  const ledgerFile = path.join(base, "agent-experience/sessions.json");
  if (existsSync(ledgerFile)) {
    try {
      if (!safe(ledgerFile)) throw Error();
      const ledger = JSON.parse(readFileSync(ledgerFile, "utf8"));
      if (!ledger.sessions || typeof ledger.sessions !== "object")
        throw Error();
      for (const session of Object.values(ledger.sessions))
        if (["running", "needs_review"].includes(session.status))
          active.push("experience");
    } catch {
      unknown.push("experience state");
    }
  }
  const directory = path.join(base, "runner-device/execution");
  if (existsSync(directory)) {
    try {
      if (!safe(directory)) throw Error();
      const { DatabaseSync } = await import("node:sqlite");
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          unknown.push("execution directory");
          continue;
        }
        const file = path.join(directory, entry.name, "adapter.sqlite");
        if (!existsSync(file)) {
          if (!knownNeverCreatedExecutor(projectRoot, path.dirname(file)))
            unknown.push("execution journal");
          continue;
        }
        let db;
        try {
          if (!safe(file)) throw Error();
          db = new DatabaseSync(file, { readOnly: true });
          for (const row of db
            .prepare("SELECT data FROM runs WHERE active = 1")
            .all()) {
            const run = JSON.parse(row.data);
            if (run.active !== false || run.terminal !== true)
              active.push("execution");
          }
        } catch {
          unknown.push("execution journal");
        } finally {
          db?.close();
        }
      }
    } catch {
      unknown.push("execution state");
    }
  }
  return { count: active.length, unknown: [...new Set(unknown)] };
}
