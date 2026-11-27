// OAuth returns are cross-site navigations by design. This only admits the
// callback document; the owner session, state, issuer and PKCE are still checked
// by the route and OAuth client before any credential is accepted.
export function isMcpOAuthNavigation({ url, method, headers }) {
  const parsed = url instanceof URL ? url : new URL(url);
  const get = (name) =>
    typeof headers.get === "function" ? headers.get(name) : headers[name];
  if (
    method !== "GET" ||
    !/^\/local\/(?:waao\/callback|mcp\/callback\/[a-zA-Z0-9_-]{1,100})$/.test(
      parsed.pathname,
    )
  )
    return false;
  if (get("origin") && get("origin") !== parsed.origin) return false;
  const mode = get("sec-fetch-mode"),
    dest = get("sec-fetch-dest");
  if ((mode && mode !== "navigate") || (dest && dest !== "document"))
    return false;
  if (
    get("sec-fetch-site") === "cross-site" &&
    (mode !== "navigate" || dest !== "document")
  )
    return false;
  const q = parsed.searchParams;
  return (
    q.getAll("state").length === 1 &&
    !!q.get("state") &&
    q.get("state").length <= 2048 &&
    ((q.getAll("code").length === 1 && !!q.get("code") && !q.has("error")) ||
      (q.getAll("error").length === 1 && !!q.get("error") && !q.has("code")))
  );
}

export function mcpReturnPath(value, fallback = "/app") {
  let route;
  try {
    route = new URL(value || fallback, "http://local.invalid");
  } catch {
    route = new URL(fallback, "http://local.invalid");
  }
  if (
    route.origin !== "http://local.invalid" ||
    !["/", "/app"].includes(route.pathname)
  )
    route = new URL(fallback, "http://local.invalid");
  const room = route.searchParams.get("room");
  const query =
    room && /^[a-zA-Z0-9_-]{1,100}$/.test(room)
      ? "?room=" + encodeURIComponent(room)
      : "";
  return route.pathname + query + "#mcp=waao";
}

export async function mcpCallbackPage(returnTo, ready, waao = true) {
  const target = waao
    ? mcpReturnPath(returnTo)
    : mcpReturnPath(returnTo).split("#")[0];
  const script =
    "location.replace(document.getElementById('continue').getAttribute('href'));";
  const hash = btoa(
    String.fromCharCode(
      ...new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script)),
      ),
    ),
  );
  const escape = (s) =>
    s
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;");
  // A local completion document starts a fresh same-origin navigation. A 303
  // would carry the cross-site redirect chain into the guarded project URL.
  return new Response(
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>返回轻单</title><p>${ready ? "连接已验证，正在返回轻单工具设置。" : "授权已接收，请返回工具设置查看连接状态。"}</p><a id="continue" href="${escape(target)}">返回轻单工具设置</a><script>${script}</script></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Frame-Options": "DENY",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": `default-src 'none'; script-src 'sha256-${hash}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
      },
    },
  );
}
