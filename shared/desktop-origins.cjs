"use strict";
const productionOrigin = "https://todo.zky.lol";
function desktopOnlineOrigins(env = process.env) {
  const result = new Set([
    productionOrigin,
    "https://qingdan-canvas.zkeyang0519.workers.dev",
  ]);
  for (const raw of (env.QINGDAN_DESKTOP_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.origin !== raw ||
      url.hostname.includes("*") ||
      url.username ||
      url.password
    )
      throw Error("轻岛线上来源必须是完整 HTTPS origin。");
    result.add(raw);
  }
  return result;
}
module.exports = { productionOrigin, desktopOnlineOrigins };
