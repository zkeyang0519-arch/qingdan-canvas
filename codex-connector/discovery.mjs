import path from "node:path";
import os from "node:os";
import { stat, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ConnectorError } from "./errors.mjs";
const exec = promisify(execFile);
const isFile = async (p) => {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
};
export async function discoverCodex(options = {}) {
  const platform = options.platform ?? process.platform,
    env = options.env ?? process.env;
  const paths = platform === "win32" ? path.win32 : path.posix;
  const candidates = [],
    warnings = [],
    seen = new Set();
  const add = async (command, source) => {
    if (!command || !paths.isAbsolute(command)) return;
    const key = platform === "win32" ? command.toLowerCase() : command;
    if (seen.has(key)) return;
    seen.add(key);
    if (await isFile(command)) candidates.push({ command, args: [], source });
  };
  if (options.manualPath) {
    const p = options.manualPath.trim();
    if (
      !paths.isAbsolute(p) ||
      (platform === "win32" && !p.toLowerCase().endsWith(".exe")) ||
      !(await isFile(p))
    )
      throw new ConnectorError(
        "CODEX_PATH_INVALID",
        "指定的 Codex 程序不存在，或不是可直接启动的可执行文件。",
        "修正路径或恢复自动发现",
      );
    return {
      candidates: [{ command: p, args: [], source: "手动指定" }],
      warnings,
    };
  }
  await add(options.cachedPath, "上次可用安装");
  await add(env.QINGDAN_CODEX_BIN, "环境配置");
  for (const folder of (env.PATH ?? env.Path ?? "")
    .split(platform === "win32" ? ";" : ":")
    .filter(Boolean)) {
    await add(
      paths.join(
        folder.replace(/^"|"$/g, ""),
        platform === "win32" ? "codex.exe" : "codex",
      ),
      "PATH",
    );
    if (platform === "win32") {
      for (const prefix of [
        "node_modules/@openai/codex",
        "node_modules/@openai/codex/node_modules/@openai/codex-win32-x64",
        "node_modules/@openai/codex-win32-x64",
      ])
        await add(
          paths.join(
            folder,
            prefix,
            "vendor/x86_64-pc-windows-msvc/codex/codex.exe",
          ),
          "本机 npm 安装",
        );
    }
  }
  const known =
    options.knownLocations ??
    (platform === "win32" && env.LOCALAPPDATA
      ? [
          paths.join(env.LOCALAPPDATA, "Programs/Codex/resources/codex.exe"),
          paths.join(env.LOCALAPPDATA, "Microsoft/WindowsApps/codex.exe"),
        ]
      : []);
  for (const p of known) await add(p, "已知安装位置");
  let packages = options.packageLocations;
  if (packages === undefined && platform === "win32") {
    try {
      const r = await exec(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-AppxPackage -Name 'OpenAI.Codex*' | Select-Object -ExpandProperty InstallLocation",
        ],
        { windowsHide: true, timeout: 4000, maxBuffer: 65536, env },
      );
      packages = r.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      packages = [];
      warnings.push("WINDOWS_PACKAGE_QUERY_UNAVAILABLE");
    }
  }
  for (const p of packages ?? [])
    await add(paths.join(p, "app/resources/codex.exe"), "Windows Codex 应用");
  // Extension installs are bounded to the current user's known extension root.
  if (options.knownLocations === undefined && platform === "win32") {
    const base = paths.join(
      env.USERPROFILE ?? os.homedir(),
      ".vscode/extensions",
    );
    try {
      for (const entry of (await readdir(base))
        .filter((n) => /^openai\.chatgpt-[\w.-]+$/.test(n))
        .slice(-10))
        await add(
          paths.join(base, entry, "bin/windows-x86_64/codex.exe"),
          "VS Code 扩展",
        );
    } catch {}
  }
  return { candidates: candidates.slice(0, 20), warnings };
}
