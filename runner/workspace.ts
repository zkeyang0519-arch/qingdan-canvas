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
const gitEnv = () => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.toUpperCase().startsWith("GIT_"),
    ),
  ),
  GIT_OPTIONAL_LOCKS: "0",
  LC_ALL: "C",
  LANG: "C",
});
const git = async (root: string, args: string[]) =>
  (
    await exec("git", ["-C", root, "-c", "core.fsmonitor=false", ...args], {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 2_000_000,
      env: gitEnv(),
    })
  ).stdout.trim();
export async function gitProjectRoot(root: string) {
  try {
    return await realpath(await git(root, ["rev-parse", "--show-toplevel"]));
  } catch (error) {
    if (
      String((error as { stderr?: string }).stderr ?? "").includes(
        "not a git repository",
      )
    )
      return null;
    throw new RunnerError(
      "WORKSPACE_CHANGED",
      "Cannot verify the project Git worktree root.",
    );
  }
}
export async function readGitBaseline(
  root: string,
): Promise<ExecutionSnapshot["context"]["gitBaseline"]> {
  if (!(await gitProjectRoot(root)))
    return { commit: null, branch: null, dirty: false };
  let commit: string | null = null;
  try {
    commit = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  } catch (error) {
    if ((error as { code?: number }).code !== 1) throw error;
  }
  const branch = (await git(root, ["branch", "--show-current"])) || null;
  return {
    commit,
    branch,
    dirty:
      (await git(root, ["status", "--porcelain", "--ignore-submodules=none"]))
        .length > 0,
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
