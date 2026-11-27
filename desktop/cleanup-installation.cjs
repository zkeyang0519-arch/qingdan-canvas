"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
async function cleanupInstallation(backup, installed, appId) {
  if (!["cn.zky.qingdao", "cn.zky.qingdao.beta"].includes(appId))
    throw Error("Unknown application");
  if (!path.isAbsolute(backup || "") || !path.isAbsolute(installed || ""))
    throw Error("Absolute installation paths required");
  backup = path.resolve(backup);
  installed = path.resolve(installed);
  const parent = path.dirname(installed),
    prefix = path.basename(installed) + ".previous-";
  if (
    parent === installed ||
    path.dirname(backup) !== parent ||
    !path.basename(backup).startsWith(prefix) ||
    !/^\d+-[-\d]+$/.test(path.basename(backup).slice(prefix.length))
  )
    throw Error("Backup is outside the owned installation directory");
  if (
    (await fs.lstat(backup)).isSymbolicLink() ||
    (await fs.realpath(path.dirname(backup))) !== (await fs.realpath(parent))
  )
    throw Error("Unexpected backup link");
  if (
    (
      await fs.readFile(path.join(backup, ".qingdao-owned-backup"), "utf8")
    ).trim() !== appId
  )
    throw Error("Backup owner does not match");
  // Only the marked sibling program backup is removed. Profiles and project
  // directories are outside this boundary; fs.rm does not follow nested links.
  await fs.rm(backup, { recursive: true, force: false, maxRetries: 3 });
}
module.exports = { cleanupInstallation };
if (require.main === module)
  cleanupInstallation(...process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
