"use strict";
const { desktopOnlineOrigins } = require("../shared/desktop-origins.cjs");

function alwaysOnTopLevel(platform) {
  // Electron 45.3.2's Windows "floating" path calls SetWindowPos behind the
  // taskbar HWND, which can demote a topmost window when that HWND is ordinary.
  // The true flag still selects kFloatingWindow with level "normal" on Windows;
  // unlike "screen-saver", this does not request a stronger desktop level.
  return platform === "win32" ? "normal" : "floating";
}

function parseAppUrl(value = "http://127.0.0.1:8790/app") {
  const url = new URL(value);
  if (
    !(
      (url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) ||
      desktopOnlineOrigins().has(url.origin)
    ) ||
    url.username ||
    url.password ||
    url.pathname !== "/app" ||
    url.hash
  )
    throw new Error("桌面入口必须是本机或已配置的线上 /app 地址。");
  return url;
}

function isTrustedPage(value, application) {
  try {
    const target = new URL(value),
      expected = parseAppUrl(application);
    return (
      target.origin === expected.origin &&
      target.pathname === "/app" &&
      !target.username &&
      !target.password &&
      !target.hash
    );
  } catch {
    return false;
  }
}

function validateLayout(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid desktop layout");
  if (input.mode === "setup") return { mode: "setup", width: 920, height: 740 };
  const hasDock = input.dock !== undefined;
  if (
    hasDock &&
    (!["top", "left", "right", "free"].includes(input.dock) ||
      typeof input.expanded !== "boolean")
  )
    throw new Error("Invalid desktop dock");
  const minimumWidth = ["left", "right"].includes(input.dock) ? 64 : 240;
  if (
    input.mode !== "island" ||
    !Number.isFinite(input.width) ||
    !Number.isFinite(input.height) ||
    input.width < minimumWidth ||
    input.width > 600 ||
    input.height < 40 ||
    input.height > 1000
  )
    throw new Error("Invalid desktop island bounds");
  return {
    mode: "island",
    width: Math.round(input.width),
    height: Math.max(64, Math.round(input.height)),
    ...(hasDock ? { dock: input.dock, expanded: input.expanded } : {}),
  };
}

function fitWindowBounds(previous, requested, work) {
  const width = Math.min(Math.round(requested.width), work.width);
  const height = Math.min(Math.round(requested.height), work.height);
  const center = previous
    ? previous.x + previous.width / 2
    : work.x + work.width / 2;
  const top = previous ? previous.y : work.y + 12;
  return {
    x: Math.round(
      Math.max(
        work.x,
        Math.min(center - width / 2, work.x + work.width - width),
      ),
    ),
    y: Math.round(
      Math.max(work.y, Math.min(top, work.y + work.height - height)),
    ),
    width,
    height,
  };
}

function islandShape(outerWidth, outerHeight) {
  const inset = 12,
    width = Math.max(1, outerWidth - inset * 2),
    height = Math.max(1, outerHeight - inset * 2);
  const radius = Math.min(
    height <= 56 ? 26 : 24,
    Math.floor(width / 2),
    Math.floor(height / 2),
  );
  const rectangles = [];
  for (let y = 0; y < radius; y++) {
    const distance = radius - y - 0.5;
    const edge = Math.max(
      0,
      Math.ceil(radius - Math.sqrt(radius * radius - distance * distance)),
    );
    rectangles.push({
      x: inset + edge,
      y: inset + y,
      width: width - edge * 2,
      height: 1,
    });
    rectangles.push({
      x: inset + edge,
      y: inset + height - y - 1,
      width: width - edge * 2,
      height: 1,
    });
  }
  if (height > radius * 2)
    rectangles.push({
      x: inset,
      y: inset + radius,
      width,
      height: height - radius * 2,
    });
  return rectangles;
}

function workspaceUrl(application, roomId) {
  if (
    typeof roomId !== "string" ||
    !roomId.trim() ||
    roomId.length > 512 ||
    /[\x00-\x1f]/.test(roomId)
  )
    throw new Error("Invalid workspace identifier");
  const url = new URL("/app", parseAppUrl(application));
  url.searchParams.set("room", roomId);
  return url.href;
}

module.exports = {
  alwaysOnTopLevel,
  parseAppUrl,
  isTrustedPage,
  validateLayout,
  fitWindowBounds,
  islandShape,
  workspaceUrl,
};
