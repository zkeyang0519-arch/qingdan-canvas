import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const pin = JSON.parse(
  await readFile(path.join(root, "runner/protocol-version.json"), "utf8"),
);
const executable = process.env.QINGDAN_CODEX_BIN ?? "codex";
const version = execFileSync(executable, ["--version"], {
  encoding: "utf8",
  windowsHide: true,
}).trim();
if (version !== `codex-cli ${pin.codexVersion}`)
  throw Error(`Expected ${pin.codexVersion}, received ${version}`);
await mkdir(path.join(root, ".tmp"), { recursive: true });
const scratch = await mkdtemp(path.join(root, ".tmp/codex-types-"));
const seeds = [
  "InitializeParams",
  "InitializeResponse",
  ...[
    "GetAccountParams",
    "GetAccountResponse",
    "ModelListParams",
    "ModelListResponse",
    "ConfigReadParams",
    "ConfigReadResponse",
    "ThreadStartParams",
    "ThreadStartResponse",
    "ThreadResumeParams",
    "ThreadResumeResponse",
    "ThreadReadParams",
    "ThreadReadResponse",
    "ThreadListParams",
    "ThreadListResponse",
    "ThreadTurnsListParams",
    "ThreadTurnsListResponse",
    "ThreadItemsListParams",
    "ThreadItemsListResponse",
    "ThreadSetNameParams",
    "TurnStartParams",
    "TurnStartResponse",
    "TurnSteerParams",
    "TurnSteerResponse",
    "TurnInterruptParams",
    "ThreadBackgroundTerminalsListParams",
    "ThreadBackgroundTerminalsListResponse",
    "ThreadBackgroundTerminalsTerminateParams",
    "ThreadBackgroundTerminalsTerminateResponse",
  ].map((name) => `v2/${name}`),
];
const visited = new Set();
try {
  execFileSync(
    executable,
    ["app-server", "generate-ts", "--experimental", "--out", scratch],
    { windowsHide: true, stdio: "pipe" },
  );
  async function copy(relative) {
    if (visited.has(relative)) return;
    visited.add(relative);
    const source = await readFile(path.join(scratch, `${relative}.ts`), "utf8");
    for (const match of source.matchAll(/from "([^"]+)"/g))
      await copy(
        path.posix.normalize(
          path.posix.join(path.posix.dirname(relative), match[1]),
        ),
      );
    const destination = path.join(root, "runner/protocol", `${relative}.ts`);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(
      destination,
      `// Codex ${pin.codexVersion}; regenerate with npm run runner:protocol.\n${source}`,
    );
  }
  for (const seed of seeds) await copy(seed);
  console.log(`Generated ${visited.size} protocol types from ${version}`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
