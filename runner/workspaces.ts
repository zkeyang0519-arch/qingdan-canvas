import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  realpath,
  stat,
  mkdir,
  writeFile,
  readFile,
  rm,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { RunnerError } from "./errors";
import {
  WORKSPACE_NAME_MAX,
  WORKSPACE_PATH_MAX,
  WORKSPACE_COUNT_MAX,
  WORKSPACE_CHECK_COUNT_MAX,
  CHECK_LABEL_MAX,
  validMetadataId,
} from "./metadata";
import { rootKey } from "./workspace";
import {
  DeviceStore,
  type WorkspaceRecord,
  type WorkspaceView,
} from "./device-store";
const exec = promisify(execFile);
const key = (value: string) => rootKey(path.resolve(value));
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const inside = (root: string, target: string) => {
  const relative = path.relative(key(root), key(target));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
};
async function identity(root: string) {
  const data = await stat(root, { bigint: true });
  if (!data.isDirectory())
    throw new RunnerError(
      "VALIDATION_ERROR",
      "Workspace root must be a directory.",
    );
  return `${data.dev}:${data.ino}:${data.birthtimeNs}`;
}
export const workspaceView = (record: WorkspaceRecord): WorkspaceView => ({
  workspaceId: record.workspaceId,
  name: record.name,
  displayPath: record.displayPath,
  revision: record.revision,
  checks: record.checks,
});
/** Explicit local registration is the sole source of path/check authorization. */
export class WorkspaceRegistry {
  readonly locksDir: string;
  private lockOwner = randomUUID();
  constructor(
    private store: DeviceStore,
    options: { locksDir?: string } = {},
  ) {
    this.locksDir =
      options.locksDir ??
      path.join(
        process.env.LOCALAPPDATA ?? os.homedir(),
        "QingdanRunner",
        "workspace-locks-v1",
      );
  }
  list() {
    return this.store.workspaces().map(workspaceView);
  }
  async register(input: {
    root: string;
    name?: string;
    checks?: { checkId: string; label: string }[];
  }): Promise<WorkspaceView> {
    if (
      typeof input.root !== "string" ||
      !path.isAbsolute(input.root) ||
      input.root.includes("\0") ||
      input.root.length > WORKSPACE_PATH_MAX ||
      (input.name !== undefined &&
        (typeof input.name !== "string" ||
          input.name.length > WORKSPACE_NAME_MAX))
    )
      throw new RunnerError(
        "VALIDATION_ERROR",
        "Choose an absolute local project directory.",
      );
    const checks = input.checks ?? [];
    if (
      !Array.isArray(checks) ||
      checks.length > WORKSPACE_CHECK_COUNT_MAX ||
      checks.some(
        (c) =>
          !c ||
          Object.keys(c).some((key) => !["checkId", "label"].includes(key)) ||
          !validMetadataId(c.checkId) ||
          typeof c.label !== "string" ||
          c.label.length > CHECK_LABEL_MAX ||
          !c.label.trim(),
      ) ||
      new Set(checks.map((c) => c.checkId)).size !== checks.length
    )
      throw new RunnerError(
        "VALIDATION_ERROR",
        "Checks must be explicitly named local check IDs.",
      );
    const selected = path.resolve(input.root);
    const root = await realpath(selected);
    if (root.length > WORKSPACE_PATH_MAX)
      throw new RunnerError(
        "VALIDATION_ERROR",
        "Workspace display path is too long.",
      );
    let lockRoot = root;
    await identity(root);
    try {
      const result = await exec(
        "git",
        ["-C", root, "rev-parse", "--show-toplevel"],
        {
          windowsHide: true,
          timeout: 5000,
          maxBuffer: 100000,
          env: { ...process.env, LC_ALL: "C", LANG: "C" },
        },
      );
      lockRoot = await realpath(result.stdout.trim());
    } catch (error) {
      // Only an actual non-Git directory can fall back to its own lock root.
      if (
        !String((error as { stderr?: string }).stderr ?? "").includes(
          "not a git repository",
        )
      )
        throw new RunnerError(
          "VALIDATION_ERROR",
          "Cannot verify the project Git worktree root.",
        );
    }
    const rootIdentity = await identity(root);
    const prior = this.store
      .workspaces()
      .find((w) => key(w.root) === key(root));
    if (prior) {
      await this.resolve(prior.workspaceId);
      return workspaceView(prior);
    }
    if (this.store.workspaces().length >= WORKSPACE_COUNT_MAX)
      throw new RunnerError(
        "VALIDATION_ERROR",
        "At most 100 workspaces can be registered.",
      );
    const sameSelected = key(await realpath(selected)) === key(root);
    const record: WorkspaceRecord = {
      workspaceId: randomUUID(),
      root,
      registeredPath: sameSelected ? selected : root,
      identity: rootIdentity,
      lockRoot,
      name: input.name?.trim() || path.basename(root),
      displayPath: root,
      revision: 1,
      checks,
    };
    if (!record.name || record.name.length > WORKSPACE_NAME_MAX)
      throw new RunnerError("VALIDATION_ERROR", "Workspace name is too long.");
    this.store.saveWorkspace(record, key(root));
    return workspaceView(record);
  }
  async resolve(workspaceId: string): Promise<WorkspaceRecord> {
    const record = this.store.workspace(workspaceId);
    if (!record)
      throw new RunnerError("ACCESS_DENIED", "Workspace is not registered.");
    try {
      if (
        key(await realpath(record.registeredPath)) !== key(record.root) ||
        (await identity(record.root)) !== record.identity
      )
        throw new Error("retargeted");
    } catch {
      throw new RunnerError(
        "WORKSPACE_CHANGED",
        "Registered directory changed or was replaced; register it explicitly again.",
      );
    }
    return record;
  }
  async resolvePath(
    workspaceId: string,
    relativePath: string,
  ): Promise<string> {
    const record = await this.resolve(workspaceId);
    if (
      typeof relativePath !== "string" ||
      !relativePath ||
      path.isAbsolute(relativePath) ||
      /[\x00-\x1f<>:"|?*]/.test(relativePath) ||
      relativePath
        .split(/[\\/]/)
        .some(
          (part) =>
            !part ||
            part === ".." ||
            part === "." ||
            /[. ]$/.test(part) ||
            /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
        )
    )
      throw new RunnerError(
        "ACCESS_DENIED",
        "Expected a project-relative path.",
      );
    const candidate = path.resolve(record.root, relativePath);
    if (!inside(record.root, candidate))
      throw new RunnerError("ACCESS_DENIED", "Path escapes the project.");
    let ancestor = candidate;
    const missing: string[] = [];
    for (;;) {
      try {
        const resolved = await realpath(ancestor);
        if (!inside(record.root, resolved))
          throw new RunnerError(
            "ACCESS_DENIED",
            "Junction or symbolic link escapes the project.",
          );
        const target = path.join(resolved, ...missing.reverse());
        await this.resolve(workspaceId);
        return target;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw error;
        missing.push(path.basename(ancestor));
        ancestor = parent;
      }
    }
  }
  assertCheck(workspaceId: string, checkId: string) {
    const check = this.store
      .workspace(workspaceId)
      ?.checks.find((item) => item.checkId === checkId);
    if (!check)
      throw new RunnerError(
        "ACCESS_DENIED",
        "Check ID is not registered for this project.",
      );
    return check;
  }
  async acquire(workspaceId: string, runId: string) {
    const record = await this.resolve(workspaceId);
    if (!runId || runId.length > 256)
      throw new RunnerError("VALIDATION_ERROR", "Invalid run identity.");
    await mkdir(this.locksDir, { recursive: true });
    const lock = path.join(this.locksDir, hash(key(record.lockRoot)));
    try {
      await mkdir(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new RunnerError(
          "WORKSPACE_BUSY",
          "Project is occupied by another or unconfirmed run.",
        );
      throw error;
    }
    try {
      await writeFile(
        path.join(lock, "owner.json"),
        JSON.stringify({
          runId,
          owner: this.lockOwner,
          workspaceId,
          rootKey: key(record.root),
        }),
        { flag: "wx" },
      );
      await this.resolve(workspaceId);
    } catch (error) {
      await rm(lock, { recursive: true, force: true });
      throw error;
    }
  }
  async release(workspaceId: string, runId: string, confirmedStopped: boolean) {
    if (confirmedStopped !== true)
      throw new RunnerError(
        "CONFIRMATION_REQUIRED",
        "Run stop must be explicitly confirmed.",
      );
    const record = this.store.workspace(workspaceId);
    if (!record)
      throw new RunnerError("ACCESS_DENIED", "Workspace is not registered.");
    const lock = path.join(this.locksDir, hash(key(record.lockRoot)));
    const owner = JSON.parse(
      await readFile(path.join(lock, "owner.json"), "utf8"),
    );
    if (owner.runId !== runId || owner.workspaceId !== workspaceId)
      throw new RunnerError(
        "WORKSPACE_BUSY",
        "Lock is owned by another or unconfirmed run.",
      );
    await rm(lock, { recursive: true });
  }
  async remove(workspaceId: string) {
    const record = this.store.workspace(workspaceId);
    if (!record)
      throw new RunnerError("ACCESS_DENIED", "Workspace is not registered.");
    if (this.store.leases().some((l) => l.workspaceId === workspaceId))
      throw new RunnerError(
        "WORKSPACE_BUSY",
        "Project has an active or unconfirmed lease.",
      );
    try {
      await stat(path.join(this.locksDir, hash(key(record.lockRoot))));
      throw new RunnerError(
        "WORKSPACE_BUSY",
        "Project is occupied by another or unconfirmed run.",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.store.removeWorkspace(workspaceId);
  }
}
