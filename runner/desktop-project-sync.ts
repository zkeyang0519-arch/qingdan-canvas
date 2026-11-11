import { execFile, type ExecFileOptions } from "node:child_process";
import { win32 } from "node:path";
import { promisify } from "node:util";

type DesktopProjectSyncOptions = {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  execute?: (
    command: string,
    args: string[],
    options: ExecFileOptions,
  ) => Promise<unknown>;
};

// Check the protocol and the same installed-app identity the CLI uses before
// choosing its installer branch. Never interpolate a workspace into this script.
const checkDesktop = String.raw`
$ErrorActionPreference = 'Stop'
$scheme = Get-Item -LiteralPath 'Registry::HKEY_CLASSES_ROOT\codex'
if ($scheme.GetValueNames() -notcontains 'URL Protocol') { exit 1 }
$app = Get-StartApps | Where-Object AppID -Like 'OpenAI.Codex_*!App' | Select-Object -First 1
if (-not $app) { exit 1 }
`;

export function createDesktopProjectSync({
  command = "codex",
  args = [],
  env,
  platform = process.platform,
  execute = promisify(execFile),
}: DesktopProjectSyncOptions = {}): (root: string) => Promise<void> {
  const powershell = win32.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const processOptions = {
    env,
    windowsHide: true,
    shell: false,
    timeout: 4000,
  };
  return async (root) => {
    if (platform !== "win32")
      throw Error("Codex 桌面项目同步目前仅支持 Windows。");
    if (
      !win32.isAbsolute(root) ||
      win32.parse(root).root.length < 2 ||
      root.includes("\0")
    )
      throw Error("Codex 桌面项目需要有效的绝对路径。");

    try {
      await execute(
        powershell,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", checkDesktop],
        processOptions,
      );
    } catch (cause) {
      throw Error("无法确认 Codex 桌面已安装且注册了打开协议。", { cause });
    }
    try {
      await execute(command, [...args, "app", root], processOptions);
    } catch (cause) {
      const timedOut =
        cause instanceof Error && "killed" in cause && cause.killed === true;
      throw Error(
        timedOut ? "打开 Codex 桌面项目超时。" : "无法打开 Codex 桌面项目。",
        { cause },
      );
    }
  };
}
