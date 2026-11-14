"use strict";

async function performSavedAction({ prepare, confirm, perform }) {
  const saved = await prepare();
  if (!saved?.ok) throw new Error("本地草稿保存失败，窗口已保留。请检查同步提示后重试。");
  if ((saved.unsynced || saved.hasDraft) && !(await confirm(saved))) return false;
  await perform();
  return true;
}

module.exports = { performSavedAction };
