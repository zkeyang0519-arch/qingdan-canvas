import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerDesktopProfile } from "../desktop/profile-location.cjs";

// Run once on a machine that previously used the source desktop, before the
// first installer launch. No profile copying, credential reads or process exit.
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const profile = path.join(projectRoot, ".tmp", "desktop-profile");
if (!fs.existsSync(profile))
  throw new Error("当前项目没有旧轻岛数据，无需迁移。");
const selected = registerDesktopProfile({
  appData: process.env.APPDATA,
  profile,
});
console.log(`轻岛将保留使用数据目录：${selected}`);
