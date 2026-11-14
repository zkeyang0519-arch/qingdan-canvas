const reject = (status, message) => Object.assign(Error(message), { status });

const validId = (value) =>
  typeof value === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
async function roomBody(req) {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json")
    throw reject(415, "需要 JSON 请求。");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024) throw reject(413, "请求过大。");
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw reject(400, "请求格式无效。");
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !validId(body.roomId)
  )
    throw reject(400, "请选择有效画布，桌面启动只接受画布编号。");
  return body.roomId;
}

// Host/Origin and local marker are checked by the loopback server. The
// browser may open the companion, but cannot choose a command, URL or profile.
export function createLocalDesktopApi({ upstream, launch }) {
  const sessionUrl = new URL("/api/session", upstream);
  if (sessionUrl.protocol !== "http:" || sessionUrl.hostname !== "127.0.0.1")
    throw Error("桌面启动接口只能连接本机轻单服务。");
  return async (req, url) => {
    if (url.pathname !== "/api/local-desktop/launch")
      throw reject(404, "找不到桌面功能。");
    if (req.method !== "POST") throw reject(405, "请通过按钮打开轻岛。");
    if (url.search) throw reject(400, "桌面启动不接受额外参数。");
    const roomId = await roomBody(req);
    const account = req.headers["x-qd-account"];
    const sessionToken = req.headers.cookie?.match(
      /(?:^|;\s*)qd_session=([a-f0-9]{64})(?:;|$)/,
    )?.[1];
    if (!validId(account) || !sessionToken)
      throw reject(401, "请先登录当前轻单账号。");
    const headers = {
      cookie: `qd_session=${sessionToken}`,
      "x-qd-account": account,
    };
    let session;
    try {
      const response = await fetch(sessionUrl, {
        headers,
        signal: AbortSignal.timeout(5000),
        redirect: "error",
        cache: "no-store",
      });
      if (!response.ok)
        throw reject(
          response.status === 401 ? 401 : 503,
          "无法验证轻单登录状态，请刷新后重试。",
        );
      session = await response.json();
    } catch (error) {
      throw error.status
        ? error
        : reject(503, "本机轻单正在启动，请稍后重试。");
    }
    if (!session?.user?.id || session.user.id !== account)
      throw reject(401, "登录账号已变化，请刷新页面。");
    const expiresAt = session.sessionExpiresAt;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now())
      throw reject(
        503,
        "本机轻单尚未提供有效的登录期限，请更新并重启本机网页服务后重试。",
      );
    try {
      const response = await fetch(
        new URL(`/api/rooms/${encodeURIComponent(roomId)}`, sessionUrl),
        {
          headers,
          signal: AbortSignal.timeout(5000),
          redirect: "error",
          cache: "no-store",
        },
      );
      if (!response.ok)
        throw reject(
          [401, 403, 404].includes(response.status) ? response.status : 503,
          "无法访问当前画布，请刷新网页后重试。",
        );
      const data = await response.json();
      if (data?.room?.id !== roomId)
        throw reject(403, "当前画布权限已变化，请刷新网页。");
    } catch (error) {
      throw error.status
        ? error
        : reject(503, "无法确认画布权限，请稍后重试。");
    }
    return await launch({
      accountId: account,
      roomId,
      sessionToken,
      expiresAt,
    });
  };
}
