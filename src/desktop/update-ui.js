export const updateIsBusy = (state) =>
  ["preparing", "saving", "stopping", "installing"].includes(state?.status);
export const updateIsReady = (state) =>
  !!state?.hasUpdate || state?.status === "downloaded";
export function updateOperation(state) {
  if (state?.status === "waiting") return "cancelUpdate";
  if (state?.retry === "resume") return "recoverUpdate";
  return updateIsReady(state) ? "installUpdate" : "checkForUpdates";
}
export function updateLabel(state) {
  if (updateIsBusy(state))
    return {
      preparing: "准备更新…",
      saving: "正在保存…",
      stopping: "停止本地服务…",
      installing: "正在安装…",
    }[state.status];
  if (state?.status === "waiting") return "取消预约";
  if (state?.retry === "resume") return "恢复本地服务";
  if (updateIsReady(state))
    return state.tasks?.some((task) => !task.checkpointedRemote)
      ? "任务结束后更新"
      : "重启并更新";
  return state?.status === "checking" ? "检查中…" : "检查更新";
}
export function updateMessage(state) {
  if (state?.error) return state.error;
  if (state?.status === "downloading")
    return Number.isFinite(state.progress)
      ? "正在后台下载 " + Math.round(state.progress) + "%"
      : "正在后台下载…";
  return (
    {
      preparing: "正在暂停接收新任务…",
      waiting: "已预约更新；当前任务结束后自动保存、安装并重启。",
      saving: "正在保存待办、输入、项目和执行检查点…",
      stopping: "正在确认受管本地服务安全退出…",
      installing: "正在安装更新，完成后自动重新打开轻岛。",
      available: "发现新版本，正在准备后台下载…",
      downloaded: "新版 " + (state?.version || "") + " 已就绪",
      checking: "正在检查更新…",
      unsupported: "此环境暂不支持自动更新。",
    }[state?.status] ||
    state?.message ||
    ""
  );
}
