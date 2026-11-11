import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const exec = promisify(execFile);

export async function readLocalRunnerDiagnostics({
  projectRoot,
  inspect,
  command = process.env.QINGDAN_CODEX_BIN || "codex",
  args = [],
}) {
  const { version } = JSON.parse(
    readFileSync(path.join(projectRoot, "package.json"), "utf8"),
  );
  const codex = { available: false, authenticated: null, version: null };
  try {
    const { stdout } = await exec(command, [...args, "--version"], {
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 16384,
    });
    const observedVersion = /^codex-cli ([^\s]+)$/.exec(stdout.trim());
    if (!observedVersion) throw Error("无法识别 Codex 版本。");
    codex.version = observedVersion[1];
    codex.authenticated = await inspect(async (adapter) => {
      const account = await adapter.account();
      if (
        typeof account?.requiresOpenaiAuth !== "boolean" ||
        !(
          account.account === null ||
          (account.account && typeof account.account === "object")
        )
      )
        throw Error("无法确认 Codex 登录状态。");
      return account.account !== null || !account.requiresOpenaiAuth;
    });
    codex.available = true;
  } catch {
    codex.error = "Codex 检查未通过，请检查安装、登录与版本兼容性。";
  }
  return { service: { version, nodeVersion: process.versions.node }, codex };
}
