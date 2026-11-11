export const APP_PATH = "/app";

export function isOpeningLocation(url = location) {
  return url.pathname === "/" && !new URLSearchParams(url.search).has("room");
}

export function appRoomPath(id) {
  return `${APP_PATH}?room=${encodeURIComponent(id)}`;
}

export function normalizeLegacyRoomLocation() {
  const url = new URL(location.href);
  if (url.pathname !== "/" || !url.searchParams.has("room")) return;
  url.pathname = APP_PATH;
  // Preserve the original encoded query and invite fragment until App consumes it.
  history.replaceState(history.state, "", url.pathname + url.search + url.hash);
}

export function enterApplication() {
  if (!isOpeningLocation()) return;
  const url = new URL(location.href);
  url.pathname = APP_PATH;
  history.pushState(null, "", url.pathname + url.search + url.hash);
}
