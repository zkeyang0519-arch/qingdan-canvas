export async function api(path, { body, ...options } = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
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
