// Portable data contains user drafts/preferences/assets, never cookies or auth
// storage. Both runtimes use this format; the source profile is never copied.
import { sharedObject } from "../shared/canvas-contract.js";
const id = (s) => typeof s === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(s);
const prefix = "qingdan.desktop.input.v1:";
export function validatePortable(value, origin, accountId) {
  if (
    value?.format !== "qingdao-portable" ||
    value.version !== 1 ||
    value.origin !== origin ||
    value.accountId !== accountId ||
    !id(accountId)
  )
    throw Error("备份与当前网站或登录账号不一致。");
  if (
    ![value.drafts, value.assets, value.inputs].every(Array.isArray) ||
    JSON.stringify(value).length > 64 * 1024 * 1024
  )
    throw Error("备份格式无效或超过 64 MB。");
  const rooms = new Set(),
    keys = new Set();
  for (const row of value.drafts) {
    const parts = typeof row?.key === "string" ? row.key.split("/") : [];
    if (
      parts.length !== 3 ||
      parts[0] !== accountId ||
      !parts.every(id) ||
      !row.value?.replica ||
      !Array.isArray(row.value.replica.objects) ||
      keys.has(row.key)
    )
      throw Error("画布草稿格式无效。");
    keys.add(row.key);
    rooms.add(parts[1]);
    const replica = row.value.replica;
    if (replica.version !== 1 || !Array.isArray(replica.base))
      throw Error("离线副本版本无效。");
    const checkObject = (object) => {
      sharedObject(object);
      if (object.boardId !== parts[1]) throw Error("草稿包含其他画布的对象。");
    };
    for (const object of replica.objects) checkObject(object);
    for (const base of replica.base) {
      if (
        !base ||
        !id(base.id) ||
        !Number.isSafeInteger(base.revision) ||
        base.revision < 0 ||
        typeof base.deleted !== "boolean"
      )
        throw Error("草稿同步版本无效。");
      if (!base.deleted) checkObject(base.data);
    }
    if (replica.flight != null) {
      if (
        replica.flight.type !== "commit" ||
        !id(replica.flight.opId) ||
        !Array.isArray(replica.flight.changes)
      )
        throw Error("待同步操作无效。");
      for (const change of replica.flight.changes) {
        if (
          !change ||
          !id(change.id) ||
          !Number.isSafeInteger(change.expectedRevision) ||
          change.expectedRevision < 0
        )
          throw Error("待同步对象版本无效。");
        if (change.data !== null) checkObject(change.data);
      }
    }
  }
  keys.clear();
  for (const row of value.inputs) {
    const scope =
      typeof row?.key === "string" && row.key.startsWith(prefix)
        ? JSON.parse(row.key.slice(prefix.length))
        : null;
    if (
      !Array.isArray(scope) ||
      scope.length !== 3 ||
      scope[0] !== origin ||
      scope[1] !== accountId ||
      !id(scope[2]) ||
      keys.has(row.key) ||
      !row.value ||
      typeof row.value !== "object" ||
      Array.isArray(row.value) ||
      !Object.values(row.value).every(
        (s) => typeof s === "string" && s.length <= 20000,
      )
    )
      throw Error("输入草稿格式无效。");
    keys.add(row.key);
  }
  keys.clear();
  for (const row of value.assets) {
    const parts = typeof row?.key === "string" ? row.key.split("/") : [];
    if (
      parts.length !== 2 ||
      !rooms.has(parts[0]) ||
      !parts.every(id) ||
      keys.has(row.key) ||
      typeof row.type !== "string" ||
      row.type.length > 200 ||
      typeof row.base64 !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        row.base64,
      )
    )
      throw Error("附件备份无效。");
    keys.add(row.key);
  }
  return value;
}
const open = () =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open("qingdan-canvas", 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("drafts");
      req.result.createObjectStore("assets");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
const rows = (db, store) =>
  new Promise((resolve, reject) => {
    const result = [],
      tx = db.transaction(store),
      req = tx.objectStore(store).openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) {
        result.push({ key: cur.key, value: cur.value });
        cur.continue();
      }
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  });
const base64 = async (blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let encoded = "";
  for (let i = 0; i < bytes.length; i += 8192)
    encoded += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(encoded);
};
export async function exportPortable(accountId, origin = location.origin) {
  if (!id(accountId)) throw Error("请先登录需要导出的账号。");
  const db = await open();
  try {
    const drafts = (await rows(db, "drafts")).filter(
      (row) =>
        typeof row.key === "string" && row.key.startsWith(accountId + "/"),
    );
    const rooms = new Set(drafts.map((row) => row.key.split("/")[1]));
    const assets = [];
    for (const row of await rows(db, "assets")) {
      if (typeof row.key === "string" && rooms.has(row.key.split("/")[0]))
        assets.push({
          key: row.key,
          type: row.value.type,
          base64: await base64(row.value),
        });
    }
    const inputs = [];
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(prefix)) continue;
      const scope = JSON.parse(key.slice(prefix.length));
      if (scope[0] === origin && scope[1] === accountId)
        inputs.push({ key, value: JSON.parse(localStorage.getItem(key)) });
    }
    return validatePortable(
      {
        format: "qingdao-portable",
        version: 1,
        origin,
        accountId,
        drafts,
        assets,
        inputs,
      },
      origin,
      accountId,
    );
  } finally {
    db.close();
  }
}
export async function importPortable(
  value,
  accountId,
  origin = location.origin,
) {
  validatePortable(value, origin, accountId);
  // Call only in the account's lobby: no live room replica may overwrite an
  // imported offline operation while this transaction is being applied.
  if (new URL(location.href).searchParams.has("room"))
    throw Error("请先返回画布列表，再导入旧版草稿。");
  const db = await open(),
    addedInputs = [];
  try {
    const existingDrafts = new Map(
      (await rows(db, "drafts")).map((r) => [r.key, r.value]),
    );
    const existingAssets = new Map(
      (await rows(db, "assets")).map((r) => [r.key, r.value]),
    );
    const drafts = [],
      assets = [];
    for (const row of value.drafts) {
      if (existingDrafts.has(row.key)) {
        if (
          JSON.stringify(existingDrafts.get(row.key)) !==
          JSON.stringify(row.value)
        )
          throw Error("验证版已有不同的画布草稿，已停止导入以保留双方内容。");
      } else drafts.push(row);
    }
    for (const row of value.assets) {
      if (existingAssets.has(row.key)) {
        const existing = existingAssets.get(row.key);
        if (
          existing.type !== row.type ||
          (await base64(existing)) !== row.base64
        )
          throw Error("验证版已有不同的附件，已停止导入。");
      } else
        assets.push({
          key: row.key,
          value: new Blob(
            [Uint8Array.from(atob(row.base64), (c) => c.charCodeAt(0))],
            { type: row.type },
          ),
        });
    }
    for (const row of value.inputs) {
      const old = localStorage.getItem(row.key),
        encoded = JSON.stringify(row.value);
      if (old !== null && JSON.stringify(JSON.parse(old)) !== encoded)
        throw Error("验证版已有不同的输入草稿，已停止导入。");
    }
    for (const row of value.inputs) {
      if (localStorage.getItem(row.key) !== null) continue;
      addedInputs.push(row.key);
      const encoded = JSON.stringify(row.value);
      localStorage.setItem(row.key, encoded);
      if (localStorage.getItem(row.key) !== encoded)
        throw Error("输入草稿未能写入本机。");
    }
    await new Promise((resolve, reject) => {
      const tx = db.transaction(["drafts", "assets"], "readwrite");
      // add, not put: any concurrent arrival aborts rather than overwrites it.
      for (const row of drafts)
        tx.objectStore("drafts").add(row.value, row.key);
      for (const row of assets)
        tx.objectStore("assets").add(row.value, row.key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || Error("导入事务已取消"));
    });
    return {
      drafts: drafts.length,
      assets: assets.length,
      inputs: addedInputs.length,
    };
  } catch (error) {
    for (const key of addedInputs) localStorage.removeItem(key);
    throw error;
  } finally {
    db.close();
  }
}
