const requestId = new URL(window.location.href).searchParams.get("request");
let channel;
function connect() {
  try {
    if (
      /^[a-f0-9-]{36}$/i.test(requestId || "") &&
      typeof BroadcastChannel === "function"
    ) {
      channel = new BroadcastChannel(`qingdao-download:${requestId}`);
    }
  } catch {
    /* Direct downloads remain available without cross-tab messaging. */
  }
}
connect();

for (const link of document.querySelectorAll("a[data-channel]")) {
  link.addEventListener("click", () => {
    const selected = link.dataset.channel;
    if (!["stable", "tauri-preview"].includes(selected)) return;
    try {
      channel?.postMessage({
        type: "qingdao-download-selected",
        channel: selected,
      });
    } catch {
      /* Installation instructions still work without the original tab. */
    }
    const label = selected === "tauri-preview" ? "轻量验证版" : "原版";
    document.getElementById("download-feedback-title").textContent =
      `已选择${label} · ${link.dataset.platform}`;
    document.getElementById("continue-link").href = `/app?desktop=${selected}`;
    document.getElementById("download-feedback").hidden = false;
  });
}
window.addEventListener("pagehide", () => {
  channel?.close();
  channel = undefined;
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) connect();
});
