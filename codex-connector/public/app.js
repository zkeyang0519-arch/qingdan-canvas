const $ = (id) => document.getElementById(id);
const fragment = new URLSearchParams(location.hash.slice(1));
let token = fragment.get("token");
try {
  if (token) sessionStorage.setItem("connectorToken", token);
  else token = sessionStorage.getItem("connectorToken");
} catch {}
history.replaceState(null, "", location.pathname);
let cursor = null,
  activeSearch = "",
  rows = [],
  listSequence = 0,
  busy = false,
  lastStatus = null,
  stopped = false;
function notice(message) {
  $("notice").hidden = !message;
  $("notice").textContent = message || "";
}
async function api(route, body) {
  const res = await fetch(route, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: "Bearer " + (token || ""),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json();
  if (!res.ok) throw Error(data.message || "读取失败，请重试。");
  return data;
}
function render(s) {
  lastStatus = s;
  const labels = {
    idle: "等待连接",
    connecting: "正在检查连接…",
    ready: "Codex 已连接",
    login_required: "Codex 已连接，需要登录",
    error: "连接需要处理",
    closed: "连接器已退出",
  };
  $("status").textContent = labels[s.status] || "状态待确认";
  $("summary").textContent =
    s.status === "ready"
      ? "已验证本机连接，可以读取会话和项目目录。"
      : s.status === "login_required"
        ? "请先在 Codex 中完成登录，再重新检测连接。"
        : "自动发现本机 Codex，检查登录状态并读取会话。";
  $("checks").replaceChildren(
    ...(s.checks || []).map((x) => {
      const el = document.createElement("div");
      el.className = "check " + x.state;
      const symbol = document.createElement("span");
      symbol.className = "symbol";
      symbol.textContent = {
        ok: "✓",
        error: "!",
        attention: "!",
        running: "◌",
        pending: "○",
      }[x.state];
      const label = document.createElement("span");
      label.textContent = x.label;
      el.append(symbol, label);
      return el;
    }),
  );
  $("installation").textContent = s.install
    ? `${s.install.source} · Codex ${s.version || "待确认"} · ${s.install.path}`
    : "尚未确认可用安装";
  $("auth").textContent = s.auth
    ? `授权状态：${{ signed_in: "已登录", required: "需要登录", not_required: "当前配置无需登录" }[s.auth.status]}${s.auth.plan ? " · " + s.auth.plan : ""}`
    : "";
  $("lastCheck").textContent = s.updatedAt
    ? "最近检查 " + new Date(s.updatedAt).toLocaleString("zh-CN")
    : "尚未完成检查";
  if (document.activeElement !== $("manualPath"))
    $("manualPath").value = s.preferences?.manualPath || "";
  if (s.error)
    notice(
      `${s.error.message} ${s.error.action || ""}${s.retryAt ? " · 正在自动重试" : ""}`,
    );
}
function setBusy(value) {
  busy = value;
  for (const id of [
    "reconnect",
    "savePath",
    "autoPath",
    "searchButton",
    "more",
  ])
    $(id).disabled = value;
}
async function connect(body) {
  if (busy || stopped) return;
  setBusy(true);
  notice("");
  $("status").textContent = "正在检查连接…";
  ++listSequence;
  try {
    const s = await api(body ? "/api/config" : "/api/connect", body || {});
    render(s);
    if (["ready", "login_required"].includes(s.status)) {
      notice("");
      await load(false);
    }
  } catch (e) {
    notice(e.message);
    $("status").textContent = "连接检查未完成";
  } finally {
    setBusy(false);
  }
}
function drawRows() {
  $("sessions").replaceChildren(
    ...rows.map((row) => {
      const button = document.createElement("button");
      button.className = "session";
      const left = document.createElement("div");
      const title = document.createElement("div");
      title.className = "session-title";
      title.textContent = row.title;
      const detail = document.createElement("div");
      detail.className = "session-path";
      detail.textContent = row.cwd;
      left.append(title, detail);
      const time = document.createElement("time");
      time.textContent = new Date(row.updatedAt * 1000).toLocaleDateString(
        "zh-CN",
      );
      button.append(left, time);
      button.addEventListener("click", () => select(row.threadId));
      return button;
    }),
  );
  $("count").textContent = rows.length + " 个会话";
  $("more").hidden = !cursor;
}
async function load(more = false) {
  const seq = ++listSequence;
  $("listMessage").textContent = "正在读取会话…";
  const requestedSearch = more ? activeSearch : $("search").value;
  const params = new URLSearchParams({ search: requestedSearch });
  if (more && cursor) params.set("cursor", cursor);
  try {
    const page = await api("/api/sessions?" + params);
    if (seq !== listSequence) return;
    rows = more
      ? [
          ...new Map(
            [...rows, ...page.sessions].map((r) => [r.threadId, r]),
          ).values(),
        ]
      : page.sessions;
    cursor = page.nextCursor;
    activeSearch = requestedSearch;
    drawRows();
    $("listMessage").textContent = rows.length
      ? "选择一个会话，核对它的项目目录。"
      : "没有找到会话。空列表不代表连接失败。";
  } catch (e) {
    if (seq === listSequence) {
      notice(e.message);
      $("listMessage").textContent = rows.length
        ? "读取失败，以下为上次结果，可能已过期。"
        : "会话读取失败，可以重新检测连接。";
    }
  }
}
let selection = 0;
async function select(id) {
  const seq = ++selection;
  try {
    const data = await api("/api/session?id=" + encodeURIComponent(id));
    if (seq !== selection) return;
    $("project").hidden = false;
    $("projectTitle").textContent = data.title;
    $("projectPath").textContent = data.cwd;
    $("projectExists").textContent = data.directoryExists
      ? "目录存在，项目位置读取成功。"
      : "此目录当前不存在，请在 Codex 中检查项目位置。";
  } catch (e) {
    notice(e.message);
  }
}
$("reconnect").addEventListener("click", () => connect());
$("savePath").addEventListener("click", () =>
  connect({ manualPath: $("manualPath").value }),
);
$("autoPath").addEventListener("click", () => connect({ manualPath: "" }));
$("searchForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (busy) return;
  setBusy(true);
  await load();
  setBusy(false);
});
$("more").addEventListener("click", async () => {
  if (busy) return;
  setBusy(true);
  await load(true);
  setBusy(false);
});
$("diagnostics").addEventListener("click", async () => {
  try {
    const data = await api("/api/diagnostics");
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "codex-connector-diagnostics.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    notice(e.message);
  }
});
$("quit").addEventListener("click", async () => {
  try {
    await api("/api/quit", {});
    stopped = true;
    setBusy(true);
    $("status").textContent = "连接器正在退出";
    $("summary").textContent = "可以关闭此页。需要时重新打开连接器即可。";
  } catch (e) {
    notice(e.message);
  }
});
async function poll() {
  if (stopped || busy) return;
  try {
    const s = await api("/api/status");
    const recovered = s.status === "ready" && lastStatus?.status !== "ready";
    render(s);
    if (recovered) {
      notice("");
      await load();
    }
  } catch {
    if (!stopped) {
      $("status").textContent = "无法连接后台程序";
      notice("连接器可能已退出，请重新打开程序。");
    }
  }
}
if (!token) notice("请通过程序启动入口打开此页，以获取本次连接的访问凭证。");
else {
  void connect();
  setInterval(poll, 3000);
}
