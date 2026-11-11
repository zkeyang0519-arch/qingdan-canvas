import { execFile } from "node:child_process";

// Only pass a ChildProcess created by this launcher, never an arbitrary PID.
export function stopOwnedChild(child) {
  if (!child || child.exitCode != null) return Promise.resolve();
  if (process.platform === "win32" && child.pid) {
    return new Promise((resolve) =>
      execFile(
        "taskkill.exe",
        ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true },
        () => resolve(),
      ),
    );
  }
  child.kill("SIGTERM");
  return Promise.resolve();
}
