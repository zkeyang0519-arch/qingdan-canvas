"use strict";
const { parseAppUrl } = require("./window-policy.cjs");
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const hexPattern = /^[a-f0-9]{64}$/;
const failedMessage = "桌面未能接入当前画布，请保留窗口并回到网页重试。";
const cancelledMessage = "已取消切换，桌面原来的画布和输入已保留。";

function validateContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("无效的桌面画布信息。");
  if (value.accountId === null && value.roomId === null) return null;
  if (
    typeof value.accountId !== "string" ||
    !idPattern.test(value.accountId) ||
    typeof value.roomId !== "string" ||
    !idPattern.test(value.roomId)
  )
    throw new Error("无效的桌面画布信息。");
  return { accountId: value.accountId, roomId: value.roomId };
}

function validateDescriptor(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== "endpoint,nonce,version" ||
    value.version !== 1 ||
    typeof value.endpoint !== "string" ||
    !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(value.endpoint) ||
    typeof value.nonce !== "string" ||
    !hexPattern.test(value.nonce)
  )
    throw new Error("桌面交接信息无效，请从网页重试。");
  let url;
  try {
    url = new URL(value.endpoint);
  } catch {
    throw new Error("桌面交接信息无效，请从网页重试。");
  }
  if (url.origin !== value.endpoint || !url.port)
    throw new Error("桌面交接信息无效，请从网页重试。");
  return { version: 1, endpoint: value.endpoint, nonce: value.nonce };
}

function validateSession(value) {
  const context = validateContext(value);
  if (
    !context ||
    typeof value.sessionToken !== "string" ||
    !hexPattern.test(value.sessionToken)
  )
    throw new Error("桌面交接的登录信息无效。");
  if (
    value.origin !== undefined &&
    (typeof value.origin !== "string" ||
      parseAppUrl(value.origin + "/app").origin !== value.origin ||
      !value.origin.startsWith("https://"))
  )
    throw new Error("桌面交接来源无效。");
  if (
    value.expiresAt !== undefined &&
    (!Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now())
  )
    throw new Error("桌面交接已过期。");
  return {
    ...context,
    sessionToken: value.sessionToken,
    ...(value.origin ? { origin: value.origin } : {}),
    ...(value.expiresAt ? { expiresAt: value.expiresAt } : {}),
  };
}

function readDescriptor(input, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let chunks = [],
      size = 0;
    const finish = (error, result) => {
      clearTimeout(timer);
      input.off("data", data);
      input.off("end", end);
      input.off("error", failed);
      input.pause();
      chunks = [];
      if (error) reject(new Error("桌面交接读取失败，请从网页重试。"));
      else resolve(result);
    };
    const data = (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > 2048) finish(true);
      else chunks.push(Buffer.from(chunk));
    };
    const end = () => {
      try {
        finish(
          false,
          validateDescriptor(
            JSON.parse(Buffer.concat(chunks).toString("utf8")),
          ),
        );
      } catch {
        finish(true);
      }
    };
    const failed = () => finish(true);
    const timer = setTimeout(failed, timeoutMs);
    input.on("data", data);
    input.once("end", end);
    input.once("error", failed);
    input.resume();
  });
}

async function claimSession(descriptor, application, fetchImpl = fetch) {
  const target = validateDescriptor(descriptor);
  const options = () => ({
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  try {
    const claim = await fetchImpl(target.endpoint + "/claim", {
      ...options(),
      method: "POST",
      headers: { Authorization: "Bearer " + target.nonce },
    });
    if (!claim.ok) throw new Error();
    const session = validateSession(await claim.json());
    const origin = session.origin || parseAppUrl(application).origin;
    const headers = {
      Cookie: "qd_session=" + session.sessionToken,
      "X-QD-Account": session.accountId,
    };
    const authenticated = await fetchImpl(origin + "/api/session", {
      ...options(),
      headers,
    });
    if (!authenticated.ok) throw new Error();
    const authentication = await authenticated.json();
    if (authentication?.user?.id !== session.accountId) throw new Error();
    const verifiedExpiry = authentication.sessionExpiresAt;
    if (verifiedExpiry !== undefined) {
      if (!Number.isSafeInteger(verifiedExpiry) || verifiedExpiry <= Date.now())
        throw new Error();
      session.expiresAt = Math.min(
        session.expiresAt || verifiedExpiry,
        verifiedExpiry,
      );
    }
    // Legacy online redemption already supplies a server-issued expiry. Older
    // local brokers can be upgraded by the authenticated owning endpoint, but
    // must never fall back to a volatile session-only desktop cookie.
    if (!session.expiresAt) throw new Error();
    const room = await fetchImpl(
      origin + "/api/rooms/" + encodeURIComponent(session.roomId),
      { ...options(), headers },
    );
    if (!room.ok || (await room.json())?.room?.id !== session.roomId)
      throw new Error();
    return session;
  } catch {
    throw new Error("桌面交接验证失败，请确认网页登录和画布权限后重试。");
  }
}

async function ensureActive(descriptor, fetchImpl = fetch) {
  const target = validateDescriptor(descriptor);
  try {
    const response = await fetchImpl(target.endpoint + "/check", {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
      headers: { Authorization: "Bearer " + target.nonce },
    });
    if (!response.ok || (await response.json())?.active !== true)
      throw new Error();
  } catch {
    throw new Error("桌面交接已过期，请回到网页重新点击。");
  }
}

async function applySessionHandoff({
  session,
  prepare,
  confirm,
  activate,
  ensureActive: checkActive = async () => {},
}) {
  const saved = await prepare();
  if (!saved?.ok) throw new Error("本地草稿保存失败，原窗口已保留。");
  const reuse =
    saved.accountId === session.accountId &&
    saved.roomId === session.roomId &&
    saved.origin === session.origin;
  if (!reuse && (saved.unsynced || saved.hasDraft) && !(await confirm(saved)))
    return { applied: false, code: "cancelled", error: cancelledMessage };
  await checkActive();
  await activate(session, { reuse });
  return { applied: true };
}

async function acknowledge(descriptor, result, fetchImpl = fetch) {
  const target = validateDescriptor(descriptor);
  const body =
    result.applied === true
      ? { applied: true }
      : {
          applied: false,
          code: result.code === "cancelled" ? "cancelled" : "failed",
          error: result.code === "cancelled" ? cancelledMessage : failedMessage,
        };
  const response = await fetchImpl(target.endpoint + "/result", {
    method: "POST",
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
    headers: {
      Authorization: "Bearer " + target.nonce,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error("桌面交接回执未送达，请从网页重试。");
}

module.exports = {
  validateDescriptor,
  validateContext,
  validateSession,
  readDescriptor,
  claimSession,
  ensureActive,
  applySessionHandoff,
  acknowledge,
  failedMessage,
};
