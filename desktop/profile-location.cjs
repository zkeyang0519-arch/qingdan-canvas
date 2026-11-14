"use strict";

const fs = require("node:fs");
const path = require("node:path");

function settingsDirectory(appData) {
  if (typeof appData !== "string" || !path.isAbsolute(appData))
    throw new Error("无法确定轻岛用户数据目录。");
  return path.join(appData, "Qingdao");
}

function validateProfile(profile) {
  if (
    typeof profile !== "string" ||
    !path.isAbsolute(profile) ||
    profile.includes("\0") ||
    path.resolve(profile) === path.parse(profile).root
  )
    throw new Error("轻岛数据位置无效，已停止启动以保护原有数据。");
  return path.resolve(profile);
}

function readRegisteredProfile({ appData, fsImpl = fs }) {
  const pointer = path.join(
    settingsDirectory(appData),
    "profile-location.json",
  );
  if (!fsImpl.existsSync(pointer)) return null;
  try {
    const record = JSON.parse(fsImpl.readFileSync(pointer, "utf8"));
    if (record.version !== 1) throw new Error("Unsupported profile record");
    const profile = validateProfile(record.profile);
    if (!fsImpl.statSync(profile).isDirectory())
      throw new Error("Missing profile");
    return profile;
  } catch (error) {
    throw new Error(
      "原轻岛数据目录暂时不可用，已停止启动。请恢复原目录后重试，不要删除登录或草稿数据。",
      { cause: error },
    );
  }
}

// Keep Chromium's complete profile in place, including its encryption metadata.
// Never copy Cookies/IndexedDB while another version may still have it open.
// Registration contains a local directory only; it cannot select an executable.
function registerDesktopProfile({ appData, profile, fsImpl = fs }) {
  const existing = readRegisteredProfile({ appData, fsImpl });
  if (existing) return existing;
  const selected = validateProfile(profile);
  fsImpl.mkdirSync(selected, { recursive: true });
  const directory = settingsDirectory(appData);
  fsImpl.mkdirSync(directory, { recursive: true });
  const pointer = path.join(directory, "profile-location.json");
  try {
    fsImpl.writeFileSync(
      pointer,
      JSON.stringify({ version: 1, profile: selected }, null, 2) + "\n",
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return readRegisteredProfile({ appData, fsImpl });
  }
  return selected;
}

function resolveDesktopProfile({
  packaged = false,
  projectRoot,
  appData,
  env = process.env,
  fsImpl = fs,
}) {
  if (env.QINGDAN_DESKTOP_PROFILE)
    return validateProfile(path.resolve(env.QINGDAN_DESKTOP_PROFILE));
  const legacy =
    projectRoot && path.join(projectRoot, ".tmp", "desktop-profile");
  // Explicitly isolated dev/test environments need no global registration.
  if (!appData && !packaged) return validateProfile(legacy);
  if (packaged) {
    const registered = readRegisteredProfile({ appData, fsImpl });
    return (
      registered ||
      registerDesktopProfile({
        appData,
        profile: path.join(settingsDirectory(appData), "profile"),
        fsImpl,
      })
    );
  }
  registerDesktopProfile({ appData, profile: legacy, fsImpl });
  return validateProfile(legacy);
}

function installedDesktopExecutable({ env = process.env, fsImpl = fs } = {}) {
  if (env.QINGDAN_DESKTOP_SOURCE === "1" || !env.LOCALAPPDATA) return null;
  if (!path.isAbsolute(env.LOCALAPPDATA)) return null;
  const executable = path.join(
    env.LOCALAPPDATA,
    "Programs",
    "Qingdao",
    "Qingdao.exe",
  );
  return fsImpl.existsSync(executable) && fsImpl.statSync(executable).isFile()
    ? executable
    : null;
}

module.exports = {
  installedDesktopExecutable,
  readRegisteredProfile,
  registerDesktopProfile,
  resolveDesktopProfile,
};
