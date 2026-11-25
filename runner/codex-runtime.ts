import { createRequire } from "node:module";
import type { ProcessOptions } from "./supervisor";
import { RunnerError } from "./errors";

const require = createRequire(import.meta.url);

// A Windows GUI process does not share the shell's aliases or npm .cmd shims.
// Run the pinned official package through Node, keeping the desktop independent.
export function resolveCodexProcess(
  options: ProcessOptions,
  resolvePackage: (id: string) => string = require.resolve,
) {
  const env = options.env ?? process.env;
  const configured =
    options.command && options.command !== "codex"
      ? options.command
      : env.QINGDAN_CODEX_BIN;
  if (configured) return { command: configured, args: options.args ?? [] };
  try {
    return {
      command: process.execPath,
      args: [
        resolvePackage("@openai/codex/bin/codex.js"),
        ...(options.args ?? []),
      ],
    };
  } catch {
    throw new RunnerError(
      "CODEX_UNAVAILABLE",
      "轻单的 Codex 运行依赖不完整，请重新安装本机 Agent 后重试。",
    );
  }
}
