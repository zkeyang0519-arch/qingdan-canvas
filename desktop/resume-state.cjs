"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { parseAppUrl } = require("./window-policy.cjs");
function readResume(profile) {
  try {
    const data = JSON.parse(
      fs.readFileSync(path.join(profile, "resume.json"), "utf8"),
    );
    if (typeof data.url !== "string") return null;
    return safeResumeUrl(data.url);
  } catch {
    return null;
  }
}
function safeResumeUrl(url) {
  const parsed = parseAppUrl(url);
  // Persist only navigation context, never credentials or arbitrary queries.
  const room = parsed.searchParams.get("room");
  parsed.search = "";
  if (room && /^[A-Za-z0-9_-]{1,100}$/.test(room))
    parsed.searchParams.set("room", room);
  return parsed.href;
}
function saveResume(profile, url) {
  const file = path.join(profile, "resume.json"),
    temp = file + ".tmp";
  fs.writeFileSync(temp, JSON.stringify({ url: safeResumeUrl(url) }), {
    mode: 0o600,
  });
  fs.renameSync(temp, file);
}
module.exports = { readResume, saveResume };
