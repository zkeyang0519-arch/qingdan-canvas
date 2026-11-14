import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");
const execute = promisify(execFile);
export const releaseBase =
  "https://github.com/zkeyang0519-arch/qingdan-canvas/releases";
const publicError = (message) =>
  Object.assign(Error(message), { desktopInstall: true });
const maxInstallerSize = 512 * 1024 * 1024;
const versionParts = (version) =>
  typeof version === "string" &&
  /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/.test(version)
    ? version.split(".").map(Number)
    : null;
export function compareDesktopVersions(left, right) {
  const a = versionParts(left),
    b = versionParts(right);
  if (!a || !b) throw publicError("轻岛版本信息无效，请重新下载安装包。");
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return Math.sign(a[i] - b[i]);
  return 0;
}
export function validateDesktopRelease(text) {
  let value;
  try {
    value = yaml.load(text, { schema: yaml.JSON_SCHEMA });
  } catch {
    throw publicError("轻岛更新信息无效。");
  }
  if (!value || !versionParts(value.version))
    throw publicError("轻岛更新版本无效。");
  const name = `Qingdao-Setup-${value.version}-x64.exe`;
  const file = value.files?.find((item) => item?.url === name);
  if (
    value.path !== name ||
    !file ||
    !Number.isSafeInteger(file.size) ||
    file.size < 1 ||
    file.size > maxInstallerSize ||
    typeof value.sha512 !== "string" ||
    !/^[A-Za-z0-9+/]{86}==$/.test(value.sha512) ||
    file.sha512 !== value.sha512
  )
    throw publicError("轻岛安装包的版本或校验信息无效。");
  return {
    version: value.version,
    name,
    size: file.size,
    sha512: value.sha512,
    url: `${releaseBase}/download/v${value.version}/${name}`,
  };
}
function trustedDownloadUrl(input) {
  const url = new URL(input);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    ![
      "github.com",
      "objects.githubusercontent.com",
      "release-assets.githubusercontent.com",
    ].includes(url.hostname)
  )
    throw publicError("轻岛下载地址不受信任，已停止安装。");
  return url;
}
export async function fetchDesktopAsset(
  url,
  { fetchImpl = fetch, signal } = {},
) {
  for (let redirects = 0; redirects < 6; redirects++) {
    const target = trustedDownloadUrl(url);
    const response = await fetchImpl(target.href, {
      redirect: "manual",
      cache: "no-store",
      signal,
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) break;
      url = new URL(location, target).href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw publicError("暂时无法取得轻岛更新，请检查网络或稍后重试。");
    }
    return response;
  }
  throw publicError("轻岛下载跳转异常，已停止安装。");
}

// Use fixed native paths and structured JSON. Never execute page-supplied paths,
// commands, installer arguments, or credentials.
export async function inspectWindowsDesktop({
  executable,
  legacyExecutable,
  env = process.env,
}) {
  const command = `$ErrorActionPreference='Stop'; $target=$env:QINGDAO_INSPECT_EXECUTABLE; $legacy=$env:QINGDAO_LEGACY_EXECUTABLE; $version=$null; if(Test-Path -LiteralPath $target){$version=(Get-Item -LiteralPath $target).VersionInfo.ProductVersion}; $running=@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $target -or ($legacy -and $_.ExecutablePath -eq $legacy) } | ForEach-Object { [int]$_.ProcessId }); @{version=$version;running=$running} | ConvertTo-Json -Compress`;
  const { stdout } = await execute(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(command, "utf16le").toString("base64"),
    ],
    {
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 16384,
      env: {
        ...env,
        QINGDAO_INSPECT_EXECUTABLE: executable,
        QINGDAO_LEGACY_EXECUTABLE: legacyExecutable || "",
      },
    },
  );
  const state = JSON.parse(stdout.trim());
  if (
    !Array.isArray(state.running) ||
    state.running.some((pid) => !Number.isSafeInteger(pid) || pid < 1)
  )
    throw Error("Invalid native process status");
  if (typeof state.version === "string")
    state.version = state.version.replace(/\.0$/, (ending, offset, full) =>
      full.split(".").length === 4 ? "" : ending,
    );
  if (state.version !== null && !versionParts(state.version))
    throw publicError("无法确认已安装的轻岛版本，请重新安装。");
  return state;
}
export async function requestDesktopExit(
  profile,
  { fetchImpl = fetch, signal, running } = {},
) {
  let control;
  try {
    control = JSON.parse(
      await fs.readFile(path.join(profile, "launch-control.json"), "utf8"),
    );
  } catch {
    /* Old versions do not support automatic safe exit. */
  }
  if (
    !control ||
    control.protocol !== 1 ||
    !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(control.endpoint) ||
    !/^[a-f0-9]{64}$/.test(control.nonce) ||
    !running?.includes(control.pid)
  )
    throw publicError(
      "正在运行的旧版轻岛尚不支持安全自动退出。请先从托盘选择“退出轻岛”，再点击网页按钮；升级后可自动完成。",
    );
  let response;
  try {
    response = await fetchImpl(control.endpoint + "/prepare-update", {
      method: "POST",
      redirect: "error",
      signal,
      headers: { Authorization: `Bearer ${control.nonce}` },
    });
    const result = await response.json();
    if (response.ok && result.saved === true && result.pid === control.pid)
      return;
  } catch {
    signal?.throwIfAborted();
  }
  throw publicError(
    "轻岛尚未完成保存或没有响应，已停止更新并保留原数据。请查看轻岛窗口后重试。",
  );
}
function runInstaller(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, ["/S"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            publicError(
              "轻岛安装未完成，可能被 Windows 阻止。请检查安装提示后重试。",
            ),
          ),
    );
  });
}

export function createDesktopInstallation({
  projectRoot,
  env = process.env,
  fetchImpl = fetch,
  inspect = inspectWindowsDesktop,
  install = runInstaller,
  requestExit = requestDesktopExit,
  wait = delay,
  release,
  downloadTimeoutMs = 15 * 60 * 1000,
} = {}) {
  if (!path.isAbsolute(env.LOCALAPPDATA || ""))
    throw Error("Missing local application directory");
  const executable = path.join(
    env.LOCALAPPDATA,
    "Programs",
    "Qingdao",
    "Qingdao.exe",
  );
  const legacyExecutable = path.join(
    projectRoot,
    "node_modules",
    "electron",
    "dist",
    "electron.exe",
  );
  const inspectCurrent = () => inspect({ executable, legacyExecutable, env });
  let pending;
  async function ensureOnce({ profile, signal, onStatus = () => {} }) {
    onStatus("正在检查轻岛安装和版本…");
    signal?.throwIfAborted();
    let current = await inspectCurrent();
    let latest;
    try {
      if (release) latest = await release();
      else {
        const response = await fetchDesktopAsset(
          `${releaseBase}/latest/download/latest.yml`,
          {
            fetchImpl,
            signal: AbortSignal.any([
              ...(signal ? [signal] : []),
              AbortSignal.timeout(10000),
            ]),
          },
        );
        let metadata = "";
        for await (const chunk of response.body) {
          metadata += Buffer.from(chunk).toString("utf8");
          if (Buffer.byteLength(metadata) > 32768)
            throw publicError("轻岛更新信息过大，已停止安装。");
        }
        latest = validateDesktopRelease(metadata);
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (current.version) {
        onStatus("暂时无法检查新版本，正在打开已安装的轻岛…");
        return {
          executable,
          version: current.version,
          warning: "暂时无法检查新版本，已打开本机现有版本。",
        };
      }
      throw publicError(
        "还没有安装轻岛，且暂时无法下载安装包。请检查网络或从项目发布页安装后重试。",
      );
    }
    if (
      current.version &&
      compareDesktopVersions(current.version, latest.version) >= 0
    ) {
      onStatus("轻岛版本已就绪，正在打开当前画布…");
      return { executable, version: current.version };
    }
    const cache = path.join(env.LOCALAPPDATA, "Qingdao", "installer-cache");
    await fs.mkdir(cache, { recursive: true });
    const download = path.join(cache, `${randomUUID()}-${latest.name}`);
    try {
      onStatus(
        current.version
          ? `发现轻岛 ${latest.version}，正在下载更新…`
          : "尚未安装轻岛，正在下载安装包…",
      );
      const response = await fetchDesktopAsset(latest.url, {
        fetchImpl,
        signal: AbortSignal.any([
          ...(signal ? [signal] : []),
          AbortSignal.timeout(downloadTimeoutMs),
        ]),
      });
      const handle = await fs.open(download, "wx", 0o600);
      const digest = createHash("sha512");
      let size = 0,
        lastPercent = -1;
      try {
        for await (const chunk of response.body) {
          signal?.throwIfAborted();
          size += chunk.length;
          if (size > latest.size)
            throw publicError("轻岛安装包大小不符，已停止安装。");
          digest.update(chunk);
          await handle.writeFile(chunk);
          const percent = Math.floor((size / latest.size) * 100);
          if (percent >= lastPercent + 5) {
            lastPercent = percent;
            onStatus(`正在下载轻岛 ${latest.version}：${percent}%`);
          }
        }
      } finally {
        await handle.close();
      }
      if (size !== latest.size || digest.digest("base64") !== latest.sha512)
        throw publicError(
          "轻岛安装包校验失败，未退出原窗口，也未安装。请重试。",
        );
      signal?.throwIfAborted();
      current = await inspectCurrent();
      if (
        current.version &&
        compareDesktopVersions(current.version, latest.version) >= 0
      )
        return { executable, version: current.version };
      let committed = false;
      if (current.running.length) {
        onStatus("正在保存登录状态、待办和输入，并退出旧版轻岛…");
        await requestExit(profile, {
          fetchImpl,
          signal: AbortSignal.timeout(15000),
          running: current.running,
        });
        committed = true;
        // Once the old window has saved and exited, finish installing even if the
        // originating browser tab closes. Never terminate the NSIS installer.
        for (let attempt = 0; attempt < 40; attempt++) {
          current = await inspectCurrent();
          if (!current.running.length) break;
          await wait(250);
        }
        if (current.running.length)
          throw publicError("旧版轻岛尚未完全退出，已停止安装以保护数据。");
      }
      onStatus("正在安装轻岛，请稍候…");
      if (!committed) signal?.throwIfAborted();
      // Recheck immediately before starting NSIS, whose default behavior could
      // otherwise terminate a concurrently reopened application.
      if ((await inspectCurrent()).running.length)
        throw publicError("轻岛又被打开了，请先退出后重试更新。");
      await install(download);
      const installed = await inspectCurrent();
      if (
        !installed.version ||
        compareDesktopVersions(installed.version, latest.version) < 0
      )
        throw publicError(
          "未能确认轻岛安装成功，请检查 Windows 安装提示后重试。",
        );
      onStatus("轻岛安装完成，正在恢复当前画布…");
      return { executable, version: installed.version, changed: true };
    } finally {
      await fs.rm(download, { force: true }).catch(() => {});
    }
  }
  return {
    ensure(options) {
      if (pending) return pending;
      pending = ensureOnce(options).finally(() => {
        pending = null;
      });
      return pending;
    },
  };
}
