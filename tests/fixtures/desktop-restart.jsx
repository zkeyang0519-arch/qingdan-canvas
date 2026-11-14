import React from "react";
import { createRoot } from "react-dom/client";
import DesktopIslandWorkspace from "../../src/desktop/DesktopIslandWorkspace.jsx";
import { openDrafts } from "../../src/sync/drafts.js";
import "../../src/desktop/desktop.css";

// This fixture uses the real workspace sync hook, draft store and preload.
// Only the remote session and WebSocket service are supplied by the QA server.
document.documentElement.className = "qingdan-desktop";
document.documentElement.dataset.desktopMode = "island";
window.qaReadDraft = async () => {
  const db = await openDrafts();
  try {
    return await db.get("drafts", "qa-restart-user/qa-restart-room/desktop-v1");
  } finally {
    db.close();
  }
};
const response = await fetch("/api/qa-session");
if (!response.ok) throw Error("Isolated session cookie was not restored");
const { user, room } = await response.json();
createRoot(document.getElementById("root")).render(
  <DesktopIslandWorkspace room={room} user={user} onLeave={() => {}} />,
);
