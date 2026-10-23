let activeAccount = null;
export function setActiveAccount(id) {
  activeAccount = id;
}
export function announceAccountChange() {
  localStorage.setItem("qingdan.account-change", crypto.randomUUID());
}
export async function api(
  path,
  { body, rawBody, accountId = activeAccount, ...options } = {},
) {
  const requestAccount = accountId;
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(rawBody ? { "Content-Type": rawBody.type } : {}),
      ...(requestAccount &&
      !["/api/auth/register", "/api/auth/login"].includes(path)
        ? { "X-QD-Account": requestAccount }
        : {}),
      ...options.headers,
    },
    body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const result = await response.json().catch(() => ({}));
  if (
    response.status === 401 &&
    requestAccount === activeAccount &&
    !path.startsWith("/api/auth/")
  )
    window.dispatchEvent(new Event("qingdan-session-expired"));
  if (!response.ok)
    throw Object.assign(
      new Error(result.error || `请求失败（${response.status}）`),
      { status: response.status },
    );
  return result;
}
export function inviteLink(room, invite) {
  const url = new URL("/", location.origin);
  url.searchParams.set("room", room);
  url.hash = new URLSearchParams({ invite }).toString();
  return url.href;
}
