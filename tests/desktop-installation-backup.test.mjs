import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { cleanupInstallation } from "../desktop/cleanup-installation.cjs";
test("installation cleanup removes only a marked sibling program backup", async (t) => {
  const root = await fs.mkdtemp(path.resolve(".tmp/install-backup-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const installed = path.join(root, "app"),
    backup = installed + ".previous-123-456",
    project = path.join(root, "project");
  for (const p of [installed, backup, project]) await fs.mkdir(p);
  await fs.writeFile(path.join(project, "work.txt"), "preserve");
  await assert.rejects(
    cleanupInstallation(project, installed, "cn.zky.qingdao"),
    /outside/,
  );
  await assert.rejects(
    cleanupInstallation(backup, installed, "cn.zky.qingdao"),
  );
  await fs.writeFile(path.join(backup, ".qingdao-owned-backup"), "another-app");
  await assert.rejects(
    cleanupInstallation(backup, installed, "cn.zky.qingdao"),
    /owner/,
  );
  await fs.writeFile(
    path.join(backup, ".qingdao-owned-backup"),
    "cn.zky.qingdao",
  );
  await fs.writeFile(path.join(backup, "old.exe"), "fixture");
  await fs.symlink(
    project,
    path.join(backup, "project-link"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await cleanupInstallation(backup, installed, "cn.zky.qingdao");
  assert.equal(
    await fs.readFile(path.join(project, "work.txt"), "utf8"),
    "preserve",
  );
  await fs.access(installed);
  await assert.rejects(fs.access(backup));
});
