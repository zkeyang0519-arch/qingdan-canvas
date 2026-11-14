const local = "http://127.0.0.1:8790/api/local-desktop/online/";
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
export async function requestOnlineLaunch(accountId, roomId, signal) {
  const prepared = await post(local + "prepare", { accountId, roomId }, signal);
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
  const result = await post(
    local + "launch",
    { requestId: prepared.requestId, ticket: grant.ticket },
    signal,
  );
  if (result?.started !== true || result?.applied !== true)
    throw Error("轻岛尚未确认接入当前画布，请重试。");
}
