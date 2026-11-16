export function watchDesktopDownloadSelection(requestId, onSelect) {
  if (typeof window.BroadcastChannel !== "function") return () => {};
  let channel;
  try {
    channel = new window.BroadcastChannel(`qingdao-download:${requestId}`);
  } catch {
    return () => {};
  }
  channel.onmessage = ({ data }) => {
    if (
      data?.type === "qingdao-download-selected" &&
      ["stable", "tauri-preview"].includes(data.channel)
    )
      onSelect(data.channel);
  };
  return () => channel.close();
}
