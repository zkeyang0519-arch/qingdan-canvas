const native = "http://127.0.0.1:8791/api/local-desktop/online/";
const agent = "http://127.0.0.1:8790/api/local-desktop/online/";
export const desktopDownloadPage =
  "https://github.com/zkeyang0519-arch/qingdan-canvas/releases/latest";
export function wakeInstalledDesktop() {
  // A fixed protocol has no credentials or commands. Browser permission to
  // open the installed app remains a user-controlled, first-use action.
  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.title = "打开轻岛";
  frame.src = "qingdao://open";
  document.body.append(frame);
  setTimeout(() => frame.remove(), 10000);
}
async function post(url, body, signal, accountId) {
  signal.throwIfAborted();
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal,
      credentials: accountId ? "same-origin" : "omit",
      ...(accountId ? {} : { targetAddressSpace: "loopback" }),
      headers: {
        "Content-Type": "application/json",
        ...(accountId
          ? { "X-QD-Account": accountId }
          : { "X-Qingdan-Local": "1" }),
      },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    signal.throwIfAborted();
    throw Error(
      accountId
        ? "无法连接线上轻单，请检查网络后重试。"
        : "无法连接本机轻单。请启动或更新本机服务，并在浏览器中允许此网站访问本机应用。",
      { cause },
    );
  }
  signal.throwIfAborted();
  let result;
  try {
    result = await response.json();
  } catch {
    throw Error("启动服务尚未就绪，请更新本机轻单后重试。");
  }
  signal.throwIfAborted();
  if (!response.ok)
    throw Error(
      typeof result?.error === "string"
        ? result.error
        : "轻岛启动失败，请刷新网页后重试。",
    );
  return result;
}
const pause = (ms, signal) =>
  new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
export async function probeInstalledDesktop(signal) {
  return post(
    native + "probe",
    {},
    AbortSignal.any([signal, AbortSignal.timeout(1500)]),
  );
}
async function prepareLaunch(accountId, roomId, signal) {
  for (const local of [native, agent, native]) {
    signal.throwIfAborted();
    try {
      const prepared = await post(
        local + "prepare",
        { accountId, roomId },
        AbortSignal.any([signal, AbortSignal.timeout(2500)]),
      );
      return { local, prepared };
    } catch {
      signal.throwIfAborted();
    }
  }
  throw Object.assign(
    Error(
      "尚未连接到轻岛。若已安装，请允许浏览器打开轻岛并访问本机应用；若尚未安装，请先下载安装包。",
    ),
    { needsInstall: true },
  );
}
export async function requestOnlineLaunch(
  accountId,
  roomId,
  signal,
  onStatus = () => {},
) {
  let { local, prepared } = await prepareLaunch(accountId, roomId, signal);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (
      !/^[a-f0-9]{32}$/.test(prepared.requestId) ||
      !/^[a-f0-9]{64}$/.test(prepared.challenge)
    )
      throw Error("本机轻单版本不支持线上交接，请更新后重试。");
    const grant = await post(
      "/api/desktop/handoff",
      { roomId, challenge: prepared.challenge },
      signal,
      accountId,
    );
    if (!/^[a-f0-9]{64}$/.test(grant.ticket))
      throw Error("线上交接未完成，请刷新网页后重试。");
    onStatus("正在检查轻岛安装和版本…");
    let polling = false;
    const pollController = new AbortController();
    const pollSignal = AbortSignal.any([signal, pollController.signal]);
    const progressTimer = setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const progress = await post(
          local + "status",
          { requestId: prepared.requestId },
          AbortSignal.any([pollSignal, AbortSignal.timeout(3000)]),
        );
        if (!pollSignal.aborted && typeof progress.message === "string")
          onStatus(progress.message);
      } catch {
        /* Older local services may not support progress yet. */
      } finally {
        polling = false;
      }
    }, 750);
    const stopProgress = () => {
      clearInterval(progressTimer);
      pollController.abort();
    };
    signal.addEventListener("abort", stopProgress, { once: true });
    let result;
    try {
      result = await post(
        local + "launch",
        { requestId: prepared.requestId, ticket: grant.ticket },
        signal,
      );
    } finally {
      signal.removeEventListener("abort", stopProgress);
      stopProgress();
    }
    if (result?.started !== true || result?.applied !== true)
      throw Error("轻岛尚未确认接入当前画布，请重试。");
    if (!result.restarting) return result;
    if (!prepared.instanceId)
      throw Error("更新正在进行，请在轻岛重启后再次点击。");
    onStatus("正在保存并安装新版轻岛，完成后会自动打开当前画布…");
    const previousInstance = prepared.instanceId;
    const deadline = Date.now() + 180000;
    let restarted = false;
    while (Date.now() < deadline) {
      await pause(750, signal);
      try {
        const probe = await probeInstalledDesktop(signal);
        if (probe.instanceId && probe.instanceId !== previousInstance) {
          restarted = true;
          break;
        }
      } catch {
        signal.throwIfAborted();
      }
    }
    if (!restarted)
      throw Error(
        "尚未确认轻岛更新完成，请检查 Windows 安装提示后重试；原有数据仍保存在本机。",
      );
    ({ local, prepared } = await prepareLaunch(accountId, roomId, signal));
  }
  throw Error("轻岛仍在更新，请等待安装完成后重试。");
}
