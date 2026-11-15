import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
const root = fileURLToPath(new URL("..", import.meta.url));
const env = { ...process.env };
// Windows treats Path/PATH as the same key, but spreading process.env creates
// a case-sensitive JS object. Keep exactly one key when extending the PATH.
const inheritedPath = process.env.PATH || process.env.Path || "";
for (const name of Object.keys(env)) {
  if (name.toLowerCase() === "path") delete env[name];
}
env.PATH = [path.dirname(process.execPath), inheritedPath].join(path.delimiter);
const local = path.join(root, ".tmp/tauri-tools");
if (
  process.platform === "win32" &&
  fs.existsSync(path.join(local, "cargo/bin/cargo.exe"))
) {
  env.CARGO_HOME = path.join(local, "cargo");
  env.RUSTUP_HOME = path.join(local, "rustup");
  env.PATH = `${path.join(local, "cargo/bin")};${env.PATH}`;
}
const mode = process.argv[2] || "dev";
const check = mode === "check";
const command = check
  ? env.CARGO_HOME
    ? path.join(
        env.CARGO_HOME,
        "bin",
        process.platform === "win32" ? "cargo.exe" : "cargo",
      )
    : "cargo"
  : process.execPath;
const args = check
  ? ["check", "--locked", "--manifest-path", "src-tauri/Cargo.toml"]
  : [
      path.join(root, "node_modules/@tauri-apps/cli/tauri.js"),
      mode,
      ...process.argv.slice(3),
    ];
const child = spawn(command, args, {
  cwd: root,
  env,
  stdio: "inherit",
  windowsHide: true,
});
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
