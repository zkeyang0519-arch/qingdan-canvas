import {
  spawn,
  execFile,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { promisify } from "node:util";
import pin from "./protocol-version.json";
import { RunnerError } from "./errors";
const exec = promisify(execFile);
export type ProcessOptions = {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  shutdownTimeoutMs?: number;
};
export class CodexSupervisor {
  child: ChildProcessWithoutNullStreams | null = null;
  constructor(private options: ProcessOptions) {}
  async start() {
    const command = this.options.command ?? "codex";
    const args = this.options.args ?? [];
    const version = (
      await exec(command, [...args, "--version"], {
        env: this.options.env,
        windowsHide: true,
        timeout: 10000,
      })
    ).stdout.trim();
    if (version !== `codex-cli ${pin.codexVersion}`)
      throw new RunnerError(
        "CODEX_VERSION_MISMATCH",
        `需要 Codex ${pin.codexVersion}，当前为 ${version}`,
      );
    const child = spawn(command, [...args, "app-server", "--stdio"], {
      env: this.options.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    this.child = child;
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    return child;
  }
  async stop() {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) =>
        setTimeout(resolve, this.options.shutdownTimeoutMs ?? 1500),
      ),
    ]);
    if (child.exitCode !== null || child.signalCode !== null || !child.pid)
      return;
    // Only the process created by this supervisor and its descendants. Never
    // kill by executable name: the user's desktop app runs another app-server.
    if (process.platform === "win32")
      await exec("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
      }).catch(() => {});
    else child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
  }
}
