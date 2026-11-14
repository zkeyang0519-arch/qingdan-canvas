// User-entered text is local to an origin, account, room and project. It must
// never be silently discarded when a renderer or the desktop process restarts.
export function inputDraftKey(origin, accountId, roomId) {
  return `qingdan.desktop.input.v1:${JSON.stringify([origin, accountId, roomId])}`;
}

function validateDrafts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("本机输入草稿格式不正确，原内容已保留，暂不能重启更新。");
  for (const text of Object.values(value)) {
    if (typeof text !== "string" || text.length > 20000)
      throw Error("本机输入草稿格式不正确，原内容已保留，暂不能重启更新。");
  }
  return value;
}

export function loadInputDrafts(key, storage = window.localStorage) {
  const raw = storage.getItem(key);
  if (raw === null) return {};
  return validateDrafts(JSON.parse(raw));
}

export function saveInputDrafts(key, drafts, storage = window.localStorage) {
  const encoded = JSON.stringify(validateDrafts(drafts));
  storage.setItem(key, encoded);
  if (storage.getItem(key) !== encoded)
    throw Error("未能确认输入草稿已保存，请稍后重试。");
}
