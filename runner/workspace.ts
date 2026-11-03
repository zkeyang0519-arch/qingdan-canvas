import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import type { ExecutionSnapshot } from "../shared/agent/contracts";
import { RunnerError } from "./errors";
const exec = promisify(execFile);
export const rootKey = (value: string) =>
  process.platform === "win32"
    ? value.replaceAll("/", "\\").toLowerCase()
    : value;
export async function canonicalRoot(root: string) {
  return realpath(root);
}
export async function readGitBaseline(
  root: string,
): Promise<ExecutionSnapshot["context"]["gitBaseline"]> {
  const git = async (args: string[]) =>
    (
      await exec("git", ["-C", root, ...args], {
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 2_000_000,
      })
    ).stdout.trim();
  try {
    await git(["rev-parse", "--show-toplevel"]);
  } catch {
    return { commit: null, branch: null, dirty: false };
  }
  let commit: string | null = null;
  try {
    commit = await git(["rev-parse", "--verify", "HEAD"]);
  } catch {
    /* unborn branch */
  }
  const branch = (await git(["branch", "--show-current"])) || null;
  return {
    commit,
    branch,
    dirty: (await git(["status", "--porcelain"])).length > 0,
  };
}
export async function assertGitBaseline(
  root: string,
  expected: ExecutionSnapshot["context"]["gitBaseline"],
) {
  const actual = await readGitBaseline(root);
  if (
    actual.commit !== expected.commit ||
    actual.branch !== expected.branch ||
    actual.dirty !== expected.dirty
  )
    throw new RunnerError(
      "GIT_BASELINE_CHANGED",
      "项目 Git 基线已变化，请刷新任务快照。",
    );
}
