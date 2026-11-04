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
import * as trialHelpers from "../scripts/lib/execution-trial.mjs";

test("named projects use readable leaf folders, keep separate bindings and preserve prior files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "qd-named-project-"));
  const workspaces = [];
  const controller = {
    status(ownerId) {
      return {
        paired: true,
        connectionStatus: "online",
        workspaces: workspaces.filter((w) => w.ownerId === ownerId),
      };
    },
    registerWorkspace(ownerId, input) {
      let workspace = workspaces.find(
        (w) => w.ownerId === ownerId && w.displayPath === input.root,
      );
      if (!workspace) {
        workspace = {
          ownerId,
          workspaceId: `workspace-${workspaces.length + 1}`,
          name: input.name,
          displayPath: input.root,
        };
        workspaces.push(workspace);
      }
      return {
        runnerId: "runner",
        workspaces: workspaces.filter((w) => w.ownerId === ownerId),
      };
    },
    executionContext() {
      return {};
    },
  };
  try {
    const a = await prepareExecutionTrial({
      projectRoot: root,
      controller,
      ownerId: "alice",
      projectName: "个人网站",
    });
    assert.equal(path.basename(a.workspace.displayPath), "个人网站");
    assert.equal(a.workspace.name, "个人网站");
    assert.match(
      a.sectionId,
      /^[a-zA-Z0-9_-]{1,100}$/,
      "section identity must satisfy the binding API contract",
    );
    assert.equal(
      a.sectionId,
      `agent-execution-project-${a.workspace.workspaceId}`,
    );
    await writeFile(
      path.join(a.workspace.displayPath, "result.txt"),
      "keep this result",
    );
    const repeated = await prepareExecutionTrial({
      projectRoot: root,
      controller,
      ownerId: "alice",
      projectName: "  个人网站  ",
    });
    assert.equal(repeated.workspace.workspaceId, a.workspace.workspaceId);
    assert.equal(
      await readFile(path.join(a.workspace.displayPath, "result.txt"), "utf8"),
      "keep this result",
    );
    const b = await prepareExecutionTrial({
      projectRoot: root,
      controller,
      ownerId: "alice",
      projectName: "个人笔记",
    });
    assert.notEqual(b.sectionId, a.sectionId);
    const otherOwner = await prepareExecutionTrial({
      projectRoot: root,
      controller,
      ownerId: "bob",
      projectName: "个人网站",
    });
    assert.notEqual(otherOwner.workspace.displayPath, a.workspace.displayPath);
    const listed = await trialHelpers.listExecutionProjects({
      projectRoot: root,
      ownerId: "alice",
      workspaces,
    });
    assert.deepEqual(
      new Set(listed.map((p) => p.name)),
      new Set(["个人网站", "个人笔记"]),
    );
    assert.ok(
      listed.every((p) => p.workspaceId !== otherOwner.workspace.workspaceId),
    );
    assert.deepEqual(
      new Set(listed.map((p) => p.sectionId)),
      new Set([a.sectionId, b.sectionId]),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("named project rejects invalid Windows names and traversal before creating directories", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "qd-invalid-name-"));
  const controller = {
    status() {
      return { paired: true, connectionStatus: "online" };
    },
    registerWorkspace() {
      throw Error("must not register");
    },
  };
  try {
    for (const projectName of [
      "",
      "..",
      ".git",
      "../escape",
      "a/b",
      "a\\b",
      "C:escape",
      "CON",
      "nul.txt",
      "LPT1",
      "COM¹",
      "test.",
      "bad\nname",
      "a".repeat(61),
    ]) {
      await assert.rejects(
        prepareExecutionTrial({
          projectRoot: root,
          controller,
          ownerId: "alice",
          projectName,
        }),
        { status: 400 },
        projectName,
      );
    }
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("named project rejects a redirected leaf folder without touching the target", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "qd-named-link-"));
  const outside = await mkdtemp(path.join(tmpdir(), "qd-named-target-"));
  try {
    const parent = path.join(
      root,
      ".tmp",
      "execution-projects",
      createHash("sha256").update("alice").digest("hex").slice(0, 24),
    );
    await mkdir(parent, { recursive: true });
    await symlink(
      outside,
      path.join(parent, "个人网站"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      prepareExecutionTrial({
        projectRoot: root,
        ownerId: "alice",
        projectName: "个人网站",
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
