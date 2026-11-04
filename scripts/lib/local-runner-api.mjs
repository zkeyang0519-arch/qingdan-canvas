const reject = (status, message) => Object.assign(Error(message), { status });

async function readBody(req, allowed) {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json")
    throw reject(415, "需要 JSON 请求。");
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) throw reject(413, "请求过大。");
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
    Object.keys(body).some((key) => !allowed.includes(key))
  )
    throw reject(400, "请求包含不支持的字段。");
  return body;
}
const stringField = (body, key, max = 4096) => {
  if (
    typeof body[key] !== "string" ||
    !body[key].trim() ||
    body[key].length > max
  )
    throw reject(400, `${key} 无效。`);
  return body[key].trim();
};

// The loopback server applies Host/Origin and local-header guards first. The
// upstream session is the only authority for the actor; bodies cannot pick one.
export function createLocalRunnerApi({
  getController,
  upstream,
  prepareTrial,
}) {
  const sessionUrl = new URL("/api/session", upstream);
  if (sessionUrl.protocol !== "http:" || sessionUrl.hostname !== "127.0.0.1")
    throw Error("Runner 控制接口只能连接本机轻单服务。");
  return async (req, url) => {
    const expectedAccount = req.headers["x-qd-account"];
    if (!expectedAccount || !req.headers.cookie)
      throw reject(401, "请先登录当前轻单账号。");
    let session;
    try {
      const response = await fetch(sessionUrl, {
        headers: {
          cookie: req.headers.cookie,
          "x-qd-account": expectedAccount,
        },
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });
      if (!response.ok)
        throw reject(
          response.status === 401 ? 401 : 503,
          "无法验证轻单登录状态。",
        );
      session = await response.json();
    } catch (error) {
      throw error.status
        ? error
        : reject(503, "本机轻单正在启动，请稍后重试。");
    }
    const ownerId = session?.user?.id;
    if (!ownerId || ownerId !== expectedAccount)
      throw reject(401, "登录账号已变化，请刷新页面。");
    const controller = getController();
    if (!controller) throw reject(503, "本机 Runner 正在准备，请稍后重试。");
    const route = url.pathname.slice("/api/local-runner".length);
    try {
      if (req.method === "GET" && route === "/status")
        return await controller.status(ownerId);
      if (req.method !== "POST") throw reject(404, "找不到本机 Runner 操作。");
      if (route === "/execution/context") {
        const body = await readBody(req, ["workspaceId"]);
        return await controller.executionContext(
          ownerId,
          stringField(body, "workspaceId", 128),
        );
      }
      if (route === "/execution/trial" && prepareTrial) {
        await readBody(req, []);
        return await prepareTrial({ controller, ownerId });
      }
      if (route === "/pair") {
        const body = await readBody(req, ["pairingCode", "deviceName"]);
        return await controller.pair({
          ownerId,
          pairingCode: stringField(body, "pairingCode", 128),
          deviceName: stringField(body, "deviceName", 100),
        });
      }
      if (route === "/workspaces") {
        const body = await readBody(req, ["root", "name"]);
        return await controller.registerWorkspace(ownerId, {
          root: stringField(body, "root"),
          ...(body.name === undefined
            ? {}
            : { name: stringField(body, "name", 100) }),
        });
      }
      if (route === "/workspaces/remove") {
        const body = await readBody(req, ["workspaceId"]);
        return await controller.removeWorkspace(
          ownerId,
          stringField(body, "workspaceId", 128),
        );
      }
      if (route === "/connection") {
        const body = await readBody(req, ["enabled"]);
        if (typeof body.enabled !== "boolean")
          throw reject(400, "连接状态无效。");
        return await controller.setEnabled(ownerId, body.enabled);
      }
      if (route === "/reconnect" || route === "/forget") {
        await readBody(req, []);
        return await controller[
          route === "/reconnect" ? "reconnect" : "forget"
        ](ownerId);
      }
      throw reject(404, "找不到本机 Runner 操作。");
    } catch (error) {
      if (!error.status)
        error.status =
          error.code === "ACCESS_DENIED"
            ? 403
            : error.code === "VALIDATION_ERROR"
              ? 400
              : 409;
      throw error;
    }
  };
}
