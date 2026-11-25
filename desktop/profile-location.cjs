"use strict";

const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

function settingsDirectory(appData, channel = "stable") {
  if (typeof appData !== "string" || !path.isAbsolute(appData))
    throw new Error("无法确定轻岛用户数据目录。");
  return path.join(appData, channel === "beta" ? "QingdaoBeta" : "Qingdao");
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

function readRegisteredProfile({ appData, fsImpl = fs, channel = "stable" }) {
  const pointer = path.join(
    settingsDirectory(appData, channel),
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
function registerDesktopProfile({
  appData,
  profile,
  fsImpl = fs,
  channel = "stable",
}) {
  const existing = readRegisteredProfile({ appData, fsImpl, channel });
  if (existing) return existing;
  const selected = validateProfile(profile);
  fsImpl.mkdirSync(selected, { recursive: true });
  const directory = settingsDirectory(appData, channel);
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
    return readRegisteredProfile({ appData, fsImpl, channel });
  }
  return selected;
}

function resolveDesktopProfile({
  packaged = false,
  projectRoot,
  appData,
  env = process.env,
  fsImpl = fs,
  channel = "stable",
}) {
  if (env.QINGDAN_DESKTOP_PROFILE)
    return validateProfile(path.resolve(env.QINGDAN_DESKTOP_PROFILE));
  if (channel === "beta")
    return (
      readRegisteredProfile({ appData, fsImpl, channel }) ||
      registerDesktopProfile({
        appData,
        fsImpl,
        channel,
        profile: path.join(settingsDirectory(appData, channel), "profile"),
      })
    );
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

function registeredInstallDirectories(env) {
  const system = env.SystemRoot || env.SYSTEMROOT;
  if (process.platform !== "win32" || !system || !path.isAbsolute(system))
    return [];
  // electron-builder records the install scope selected in the Windows wizard.
  const command =
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); foreach ($hive in 'HKEY_CURRENT_USER','HKEY_LOCAL_MACHINE') { [Microsoft.Win32.Registry]::GetValue(($hive+'\\Software\\ac3646b8-59ba-589d-9c6f-4c69eeeddcf0'),'InstallLocation','') }";
  try {
    return execFileSync(
      path.join(system, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-Command", command],
      {
        env,
        windowsHide: true,
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    )
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function installedDesktopExecutable({
  env = process.env,
  fsImpl = fs,
  readInstallDirectories = registeredInstallDirectories,
} = {}) {
  if (env.QINGDAN_DESKTOP_SOURCE === "1" || !env.LOCALAPPDATA) return null;
  if (!path.isAbsolute(env.LOCALAPPDATA)) return null;
  for (const directory of [
    ...readInstallDirectories(env),
    path.join(env.LOCALAPPDATA, "Programs", "Qingdao"),
  ]) {
    if (
      !directory ||
      !path.isAbsolute(directory) ||
      directory === path.parse(directory).root
    )
      continue;
    const executable = path.join(directory, "Qingdao.exe");
    try {
      if (fsImpl.statSync(executable).isFile()) return executable;
    } catch {
      /* A moved or uninstalled copy can leave a stale path. */
    }
  }
  return null;
}

module.exports = {
  installedDesktopExecutable,
  readRegisteredProfile,
  registerDesktopProfile,
  resolveDesktopProfile,
};
