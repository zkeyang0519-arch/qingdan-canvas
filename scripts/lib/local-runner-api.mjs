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
function workspaceQuery(url) {
  const keys = [...url.searchParams.keys()];
  if (
    keys.length !== 2 ||
    !keys.includes("runnerId") ||
    !keys.includes("workspaceId")
  )
    throw reject(400, "需要已关联电脑和项目编号。");
  const query = Object.fromEntries(url.searchParams);
  return {
    runnerId: stringField(query, "runnerId", 128),
    workspaceId: stringField(query, "workspaceId", 128),
  };
}

// The loopback server applies Host/Origin and local-header guards first. The
// upstream session is the only authority for the actor; bodies cannot pick one.
export function createLocalRunnerApi({
  getController,
  upstream,
  prepareTrial,
  listTrials,
  getDiagnostics,
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
    const revocationEvidence = async (target, revoke = false) => {
      if (
        target.ownerId !== ownerId ||
        target.serverOrigin !== sessionUrl.origin
      )
        throw reject(403, "原设备不属于当前登录账号或轻单服务。");
      const headers = { cookie: req.headers.cookie, "x-qd-account": ownerId };
      if (revoke) {
        try {
          await fetch(
            new URL(
              "/api/agent/devices/" +
                encodeURIComponent(target.runnerId) +
                "/revoke",
              sessionUrl,
            ),
            {
              method: "POST",
              headers: { ...headers, "content-type": "application/json" },
              body: "{}",
              signal: AbortSignal.timeout(5000),
              redirect: "error",
            },
          );
        } catch {
          // The revoke may have committed before its ACK was lost. Only the
          // authenticated GET below can authorize local cleanup.
        }
      }
      let response, data;
      try {
        response = await fetch(new URL("/api/agent/devices", sessionUrl), {
          headers,
          signal: AbortSignal.timeout(5000),
          redirect: "error",
          cache: "no-store",
        });
        if (!response.ok)
          throw reject(
            response.status === 401 ? 401 : 503,
            "无法核实原设备的撤销状态。",
          );
        data = await response.json();
      } catch (error) {
        throw error.status
          ? error
          : reject(503, "设备服务暂时不可用，请稍后重新核对。");
      }
      const device =
        Array.isArray(data?.devices) &&
        data.devices.find(
          (item) =>
            item.runnerId === target.runnerId && item.ownerId === ownerId,
        );
      if (
        !device ||
        device.status !== "revoked" ||
        !Number.isSafeInteger(device.authEpoch) ||
        device.authEpoch <= target.authEpoch
      )
        throw reject(409, "请先在当前账号撤销原设备，再核对并重置本机绑定。");
      return {
        runnerId: device.runnerId,
        ownerId: device.ownerId,
        serverOrigin: sessionUrl.origin,
        status: device.status,
        authEpoch: device.authEpoch,
      };
    };
    const route = url.pathname.slice("/api/local-runner".length);
    try {
      if (req.method === "GET" && route === "/diagnostics" && getDiagnostics) {
        await controller.status(ownerId);
        const diagnostics = await getDiagnostics();
        // Installation probes can outlive a connection or pairing change.
        // Recheck both ownership and connection before returning this snapshot.
        const state = await controller.status(ownerId);
        return {
          ...diagnostics,
          connectionStatus: state.connectionStatus,
          checkedAt: new Date().toISOString(),
        };
      }
      if (req.method === "GET" && route === "/status") {
        const state = await controller.status(ownerId);
        return listTrials
          ? {
              ...state,
              executionProjects: await listTrials({ ownerId, state }),
            }
          : state;
      }
      if (req.method === "GET" && route === "/codex/sessions") {
        const query = Object.fromEntries(url.searchParams);
        if (
          Object.keys(query).some(
            (key) => !["cursor", "searchTerm"].includes(key),
          )
        )
          throw reject(400, "会话查询包含不支持的字段。");
        return await controller.listCodexSessions(ownerId, {
          ...(query.cursor
            ? { cursor: stringField(query, "cursor", 4096) }
            : {}),
          ...(query.searchTerm?.trim()
            ? { searchTerm: stringField(query, "searchTerm", 200) }
            : {}),
        });
      }
      if (req.method === "GET" && route === "/codex/models") {
        return await controller.listCodexModels(
          ownerId,
          url.search ? workspaceQuery(url) : undefined,
        );
      }
      if (req.method === "GET" && route === "/workspaces/verify") {
        return await controller.verifyWorkspace(ownerId, workspaceQuery(url));
      }
      if (req.method !== "POST") throw reject(404, "找不到本机 Runner 操作。");
      if (route === "/codex/select") {
        const body = await readBody(req, ["threadId"]);
        return await controller.selectCodexSession(
          ownerId,
          stringField(body, "threadId", 128),
        );
      }
      if (route === "/execution/context") {
        const body = await readBody(req, ["workspaceId"]);
        return await controller.executionContext(
          ownerId,
          stringField(body, "workspaceId", 128),
        );
      }
      if (route === "/execution/trial" && prepareTrial) {
        const body = await readBody(req, ["projectName"]);
        return await prepareTrial({
          controller,
          ownerId,
          ...(body.projectName === undefined
            ? {}
            : { projectName: stringField(body, "projectName", 60) }),
        });
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
      if (route === "/reset") {
        const body = await readBody(req, ["expectedRunnerId"]);
        return await controller.reset(
          ownerId,
          stringField(body, "expectedRunnerId", 128),
          (target) => revocationEvidence(target),
        );
      }
      if (route === "/forget") {
        const body = await readBody(req, ["expectedRunnerId"]);
        if (!Object.hasOwn(body, "expectedRunnerId"))
          return await controller.forget(ownerId);
        return await controller.forget(ownerId, {
          expectedRunnerId: stringField(body, "expectedRunnerId", 128),
          revokeAndVerify: (target) => revocationEvidence(target, true),
        });
      }
      if (route === "/reconnect") {
        await readBody(req, []);
        return await controller.reconnect(ownerId);
      }
      throw reject(404, "找不到本机 Runner 操作。");
    } catch (error) {
      if (!error.status)
        error.status = ["ACCESS_DENIED", "OWNER_MISMATCH"].includes(error.code)
          ? 403
          : error.code === "VALIDATION_ERROR"
            ? 400
            : 409;
      throw error;
    }
  };
}
