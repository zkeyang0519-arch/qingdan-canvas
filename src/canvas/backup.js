import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { validateWorkspace, parseWorkspace } from "./model.js";

export async function exportArchive(input, assets) {
  const state = validateWorkspace(input);
  const files = { "workspace.json": strToU8(JSON.stringify(state)) };
  for (const [key, meta] of Object.entries(state.assets)) {
    const blob = assets.get(key);
    if (!(blob instanceof Blob) || blob.size !== meta.byteLength)
      throw new Error("图片资源不完整，不能导出完整备份。");
    files[`assets/${key}`] = [
      new Uint8Array(await blob.arrayBuffer()),
      { level: 0 },
    ];
  }
  return zipSync(files, { level: 6 });
}
export async function importArchive(bytes) {
  let files;
  let total = 0;
  try {
    files = unzipSync(bytes, {
      filter: (entry) => {
        total += entry.originalSize;
        if (total > 512 * 1024 * 1024)
          throw new Error("归档展开后超过 512MB，请拆分后导入。");
        return (
          entry.name === "workspace.json" || /^assets\/[\w-]+$/.test(entry.name)
        );
      },
    });
  } catch (e) {
    throw new Error(`无法读取备份归档：${e.message}`);
  }
  if (!files["workspace.json"]) throw new Error("归档缺少 workspace.json。");
  const state = parseWorkspace(strFromU8(files["workspace.json"]));
  const assets = new Map();
  for (const [key, meta] of Object.entries(state.assets)) {
    const raw = files[`assets/${key}`];
    if (!raw || raw.length !== meta.byteLength)
      throw new Error("备份中的图片资源缺失或损坏。");
    assets.set(key, new Blob([raw], { type: meta.mime }));
  }
  return { state, assets };
}
export async function readBackupFile(file) {
  if (file.size > 512 * 1024 * 1024)
    throw new Error("备份文件过大，请先拆分工作区。");
  if (file.name.toLowerCase().endsWith(".json")) {
    const state = parseWorkspace(await file.text());
    if (Object.keys(state.assets).length)
      throw new Error("包含图片的工作区需导入完整 .qingdan 归档。");
    return { state, assets: new Map() };
  }
  return importArchive(new Uint8Array(await file.arrayBuffer()));
}
export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
