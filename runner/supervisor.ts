import {
  spawn,
  execFile,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { promisify } from "node:util";
import pin from "./protocol-version.json";
import { RunnerError } from "./errors";
import { resolveCodexProcess } from "./codex-runtime";
const exec = promisify(execFile);
export type ProcessOptions = {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  shutdownTimeoutMs?: number;
  compatibleVersions?: readonly string[];
  // Local connectors probe the protocol before exposing any tool. The pinned
  // execution Runner keeps its existing version contract by default.
  protocolPolicy?: "pinned" | "probe";
  stdioTransport?: "stdio" | "listen";
};
export class CodexSupervisor {
  child: ChildProcessWithoutNullStreams | null = null;
  constructor(private options: ProcessOptions) {}
  async start() {
    const { command, args } = resolveCodexProcess(this.options);
    // The desktop's registered-Core routing applies only to its own host.
    // A standalone app-server must select its normal Windows sandbox launcher.
    // Copy rather than mutate the caller's environment; retain auth/config paths.
    const env = { ...(this.options.env ?? process.env) };
    for (const key of Object.keys(env))
      if (key.toUpperCase() === "CODEX_WINDOWS_REGISTERED_CORE")
        delete env[key];
    const version = (
      await exec(command, [...args, "--version"], {
        env,
        windowsHide: true,
        timeout: 10000,
      })
    ).stdout.trim();
    const supported = Array.from(
      new Set([pin.codexVersion, ...(this.options.compatibleVersions ?? [])]),
    );
    if (
      !/^codex-cli \d+\.\d+\.\d+(?:[-+.][\w.-]+)?$/.test(version) ||
      (this.options.protocolPolicy !== "probe" &&
        !supported.some((v) => version === `codex-cli ${v}`))
    )
      throw new RunnerError(
        "CODEX_VERSION_MISMATCH",
        `需要 Codex ${supported.join(" 或 ")}，当前为 ${version}`,
      );
    const transport =
      this.options.stdioTransport === "listen"
        ? ["--listen", "stdio://"]
        : ["--stdio"];
    const child = spawn(command, [...args, "app-server", ...transport], {
      env,
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
