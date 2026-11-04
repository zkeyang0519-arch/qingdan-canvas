import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  symlink,
  readdir,
  mkdir,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { prepareExecutionTrial } from "../scripts/lib/execution-trial.mjs";

test("trial Git operations ignore redirected environment and trial-provided hooks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "qd-trial-git-"));
  const outside = await mkdtemp(path.join(tmpdir(), "qd-trial-foreign-"));
  const prior = {
    GIT_DIR: process.env.GIT_DIR,
    GIT_WORK_TREE: process.env.GIT_WORK_TREE,
  };
  const trial = path.join(
    root,
    ".tmp",
    "execution-trial",
    createHash("sha256").update("alice").digest("hex").slice(0, 24),
  );
  const controller = {
    status() {
      return { paired: true, connectionStatus: "online" };
    },
    registerWorkspace(ownerId, input) {
      return {
        runnerId: "runner",
        workspaces: [{ workspaceId: "trial", displayPath: input.root }],
      };
    },
    executionContext() {
      return {};
    },
  };
  try {
    await mkdir(path.join(trial, ".no-hooks"), { recursive: true });
    await writeFile(
      path.join(trial, ".no-hooks", "pre-commit"),
      `#!/bin/sh\nprintf unsafe > '${outside.replaceAll("\\", "/")}/hook-ran'\n`,
      { mode: 0o755 },
    );
    process.env.GIT_DIR = path.join(outside, "metadata");
    process.env.GIT_WORK_TREE = outside;
    await prepareExecutionTrial({
      projectRoot: root,
      ownerId: "alice",
      controller,
    });
    assert.deepEqual(await readdir(outside), []);
    assert.match(
      await readFile(path.join(trial, ".git", "HEAD"), "utf8"),
      /^ref:/,
    );
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("isolated dispatch trial uses a fixed owner directory and preserves user's trial output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "qd-execution-trial-"));
  const calls = [];
  const controller = {
    status(ownerId) {
      assert.equal(ownerId, "alice");
      return { paired: true, connectionStatus: "online", runnerId: "runner" };
    },
    async registerWorkspace(ownerId, input) {
      calls.push({ ownerId, ...input });
      return {
        runnerId: "runner",
        workspaces: [
          { workspaceId: "trial", displayPath: input.root, name: input.name },
        ],
      };
    },
    async executionContext(ownerId, workspaceId) {
      assert.equal(ownerId, "alice");
      assert.equal(workspaceId, "trial");
      return { capturedAt: new Date().toISOString() };
    },
  };
  try {
    const result = await prepareExecutionTrial({
      projectRoot: root,
      controller,
      ownerId: "alice",
    });
    assert.equal(result.workspace.workspaceId, "trial");
    assert.ok(
      calls[0].root.startsWith(
        path.join(root, ".tmp", "execution-trial") + path.sep,
      ),
    );
    assert.match(
      await readFile(path.join(calls[0].root, "README.md"), "utf8"),
      /独立测试项目/,
    );
    await writeFile(path.join(calls[0].root, "hello.txt"), "user output");
    await prepareExecutionTrial({
      projectRoot: root,
      controller,
      ownerId: "alice",
    });
    assert.equal(calls[1].root, calls[0].root);
    assert.equal(
      await readFile(path.join(calls[0].root, "hello.txt"), "utf8"),
      "user output",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trial preparation rejects an unpaired or offline device before creating files", async () => {
  for (const status of [
    { paired: false },
    { paired: true, connectionStatus: "offline" },
  ]) {
    await assert.rejects(
      prepareExecutionTrial({
        projectRoot: "unused",
        controller: {
          status() {
            return status;
          },
        },
        ownerId: "alice",
      }),
      /绑定|在线/,
    );
  }
});
test("trial preparation rejects a redirected scratch directory before writing into its target", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "qd-trial-root-"));
  const outside = await mkdtemp(path.join(tmpdir(), "qd-trial-outside-"));
  try {
    await symlink(
      outside,
      path.join(root, ".tmp"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      prepareExecutionTrial({
        projectRoot: root,
        ownerId: "alice",
        controller: {
          status() {
            return { paired: true, connectionStatus: "online" };
          },
        },
      }),
      /重定向/,
    );
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
