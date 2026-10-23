import { validateImageData } from "../src/canvas/images.js";
import { validDeadline } from "./deadline.js";
import { validTaskAuthor } from "./task-authors.js";
const fields = new Set(
  "id type boardId parentId x y width height zIndex locked createdAt updatedAt title collapsed fixedBounds noteKind color blocks blockOrder fixedHeight assetId alt naturalWidth naturalHeight crop rotation flipX annotations cloudAssetId assetMetadata".split(
    " ",
  ),
);
const valid = (condition) => {
  if (!condition)
    throw Object.assign(Error("画布对象结构无效"), { status: 400 });
};
const date = (v) => typeof v === "string" && Number.isFinite(Date.parse(v));
const string = (v) => typeof v === "string";
const pick = (value, keys) =>
  Object.fromEntries(
    keys.filter((k) => value[k] !== undefined).map((k) => [k, value[k]]),
  );
// DOM measurements belong to the local renderer, including in older drafts.
export function withoutLayoutMeasurement(value) {
  if (value?.type !== "note" || !Object.hasOwn(value, "layoutHeight"))
    return value;
  const { layoutHeight, ...data } = value;
  return data;
}
export function sharedObject(value) {
  if (
    !value ||
    typeof value.id !== "string" ||
    value.id.length > 256 ||
    !["note", "image", "frame", "collection"].includes(value.type)
  )
    throw Error("画布对象无效");
  const clean = Object.fromEntries(
    Object.entries(value).filter(([key]) => fields.has(key)),
  );
  valid(
    string(clean.boardId) &&
      ["x", "y", "width", "height", "zIndex"].every((k) =>
        Number.isFinite(clean[k]),
      ) &&
      clean.width > 0 &&
      clean.height > 0,
  );
  valid(
    typeof clean.locked === "boolean" &&
      (clean.parentId === null || string(clean.parentId)) &&
      clean.parentId !== clean.id &&
      date(clean.createdAt) &&
      date(clean.updatedAt),
  );
  if (["frame", "collection"].includes(clean.type))
    valid(string(clean.title) && typeof clean.collapsed === "boolean");
  if (clean.type === "note") {
    valid(
      clean.fixedHeight === undefined || typeof clean.fixedHeight === "boolean",
    );
    valid(
      ["text", "checklist"].includes(clean.noteKind) &&
        ["paper", "sage", "sand", "rose", "blue", "lavender"].includes(
          clean.color,
        ) &&
        Array.isArray(clean.blocks),
    );
    const ids = new Set();
    clean.blocks = clean.blocks.map((block) => {
      valid(
        block &&
          string(block.id) &&
          !ids.has(block.id) &&
          Array.isArray(block.runs) &&
          typeof block.done === "boolean" &&
          date(block.createdAt) &&
          (block.done ? date(block.completedAt) : block.completedAt === null),
      );
      ids.add(block.id);
      valid(validTaskAuthor(block));
      valid(
        block.dueAt === undefined ||
          block.dueAt === null ||
          validDeadline(block.dueAt),
      );
      valid(
        block.arrangedOrder === undefined ||
          (Number.isSafeInteger(block.arrangedOrder) &&
            block.arrangedOrder >= 0),
      );
      const b = pick(block, [
        "id",
        "done",
        "createdAt",
        "completedAt",
        "dueAt",
        "arrangedOrder",
        "createdByUserId",
        "createdByName",
      ]);
      b.runs = block.runs.map((r) => {
        valid(
          r &&
            (r.type === "text"
              ? string(r.text)
              : r.type === "ref" && string(r.targetId) && string(r.label)),
        );
        return pick(
          r,
          r.type === "text" ? ["type", "text"] : ["type", "targetId", "label"],
        );
      });
      if (block.remark !== undefined) {
        valid(
          block.remark &&
            string(block.remark.text) &&
            date(block.remark.updatedAt),
        );
        b.remark = pick(block.remark, ["text", "updatedAt"]);
      }
      return b;
    });
    if (clean.blockOrder !== undefined)
      valid(
        Array.isArray(clean.blockOrder) &&
          clean.blockOrder.every(string) &&
          new Set(clean.blockOrder).size === clean.blockOrder.length,
      );
  }
  if (clean.type === "image") {
    valid(
      string(clean.assetId) &&
        string(clean.alt) &&
        clean.naturalWidth > 0 &&
        clean.naturalHeight > 0,
    );
    validateImageData(clean);
    if (clean.crop)
      clean.crop = pick(clean.crop, ["x", "y", "width", "height"]);
    if (clean.annotations)
      clean.annotations = clean.annotations.map((mark) => ({
        ...pick(mark, ["id", "kind", "color", "text"]),
        points: mark.points.map((p) => pick(p, ["x", "y"])),
      }));
    if (clean.assetMetadata)
      clean.assetMetadata = pick(clean.assetMetadata, [
        "id",
        "mime",
        "byteLength",
      ]);
  }
  if (JSON.stringify(clean).length > 256000) throw Error("画布对象过大");
  return structuredClone(clean);
}
export function applyCanvasOperation(current, operation) {
  if (
    !Number.isSafeInteger(operation.expectedRevision) ||
    operation.expectedRevision !== (current?.revision || 0)
  )
    throw Object.assign(Error("对象版本冲突，请核对本地草稿与共享版本。"), {
      status: 409,
    });
  if (!["put", "delete"].includes(operation.type)) throw Error("画布操作无效");
  if (operation.type === "put" && operation.data?.id !== operation.id)
    throw Error("对象标识不一致");
  return {
    revision: (current?.revision || 0) + 1,
    deleted: operation.type === "delete",
    data: operation.type === "put" ? sharedObject(operation.data) : null,
  };
}
