import { discoverCodex } from "../../codex-connector/discovery.mjs";
import { stat, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const runtimeEnv =
  /^(path|pathext|systemroot|windir|comspec|tmp|temp|tmpdir|home|userprofile|appdata|localappdata|programfiles(?:\(x86\))?|programdata|lang|lc_all|systemdrive|codex_home|xdg_(config|data|state|cache)_home|openai_api_key|codex_api_key|https?_proxy|all_proxy|no_proxy|node_extra_ca_certs|ssl_cert_file)$/i;

export function codexRuntime({ command, args = [], env = process.env } = {}) {
  let discovered,
    discoveredAt = 0;
  const hashes = new Map();
  const transports = new Map();
  const runtime = {
    env: Object.fromEntries(
      Object.entries(env).filter(([name]) => runtimeEnv.test(name)),
    ),
    args,
    async command() {
      if (command && command !== "codex") return command;
      // Discovery is cheap compared with starting app-server and notices a
      // desktop update even while this host remains open.
      if (discovered && !(await stat(discovered).catch(() => null)))
        discovered = undefined;
      if (!discovered || Date.now() - discoveredAt > 2000) {
        const { candidates } = await discoverCodex({ env });
        const first = candidates[0];
        discovered =
          first?.source === "PATH" &&
          /WindowsApps[\\/]OpenAI\.Codex_/i.test(first.command)
            ? candidates.find((item) => item.source === "Windows Codex 应用")
                ?.command || first.command
            : first?.command;
        discoveredAt = Date.now();
      }
      return discovered || "codex";
    },
    async inspect() {
      const executable = await runtime.command();
      let version;
      try {
        version = (
          await promisify(execFile)(executable, [...args, "--version"], {
            env: runtime.env,
            windowsHide: true,
            timeout: 10000,
            maxBuffer: 65536,
          })
        ).stdout.trim();
      } catch (error) {
        runtime.reset();
        throw error;
      }
      if (!/^codex-cli \d+\.\d+\.\d+(?:[-+.][\w.-]+)?$/.test(version))
        throw Object.assign(Error("无法确认 Codex 程序版本。"), {
          code: "CODEX_VERSION_MISMATCH",
        });
      const file = await stat(executable);
      const signature = `${executable}:${file.size}:${file.mtimeMs}`;
      if (!hashes.has(signature))
        hashes.set(
          signature,
          createHash("sha256")
            .update(await readFile(executable))
            .digest("hex"),
        );
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify({ binary: hashes.get(signature), version, args }),
        )
        .digest("hex");
      if (!transports.has(fingerprint)) {
        const help = await promisify(execFile)(
          executable,
          [...args, "app-server", "--help"],
          {
            env: runtime.env,
            windowsHide: true,
            timeout: 10000,
            maxBuffer: 65536,
          },
        )
          .then((result) => result.stdout)
          .catch(() => "");
        transports.set(
          fingerprint,
          !/--stdio\b/.test(help) &&
            /--listen\b/.test(help) &&
            help.includes("stdio://")
            ? "listen"
            : "stdio",
        );
      }
      return {
        command: executable,
        args,
        version,
        fingerprint,
        stdioTransport: transports.get(fingerprint),
      };
    },
    reset() {
      discovered = undefined;
    },
  };
  return runtime;
}
