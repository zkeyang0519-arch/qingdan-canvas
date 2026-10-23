import { withoutLayoutMeasurement } from "../../shared/canvas-contract.js";
import { adoptTaskAuthors } from "../../shared/task-authors.js";

export const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export class ConflictError extends Error {
  constructor(path) {
    super(`内容冲突：${path || "对象"}。本地草稿已保留，请选择保留哪个版本。`);
    this.name = "ConflictError";
    this.path = path;
  }
}
export function mergeData(base, local, remote, path = "", resolution) {
  if (equal(local, base)) return remote;
  if (equal(remote, base) || equal(local, remote)) return local;
  if (
    path.endsWith("updatedAt") &&
    typeof local === "string" &&
    typeof remote === "string"
  )
    return local > remote ? local : remote;
  if (
    Array.isArray(base) &&
    Array.isArray(local) &&
    Array.isArray(remote) &&
    [...base, ...local, ...remote].every(
      (item) => record(item) && typeof item.id === "string",
    )
  ) {
    const a = new Map(base.map((v) => [v.id, v]));
    const b = new Map(local.map((v) => [v.id, v]));
    const c = new Map(remote.map((v) => [v.id, v]));
    return [...new Set([...c.keys(), ...b.keys()])]
      .map((id) =>
        mergeData(a.get(id), b.get(id), c.get(id), `${path}.${id}`, resolution),
      )
      .filter(Boolean);
  }
  if (record(base) && record(local) && record(remote)) {
    const result = {};
    for (const key of new Set([
      ...Object.keys(base),
      ...Object.keys(local),
      ...Object.keys(remote),
    ])) {
      const value = mergeData(
        base[key],
        local[key],
        remote[key],
        path ? `${path}.${key}` : key,
        resolution,
      );
      if (value !== undefined) result[key] = value;
    }
    return result;
  }
  if (resolution === "local") return local;
  if (resolution === "remote") return remote;
  throw new ConflictError(path);
}
const rowMap = (rows) =>
  new Map(
    rows.map((row) => [
      row.id,
      row.deleted ? null : withoutLayoutMeasurement(row.data),
    ]),
  );
export function reconcile(baseRows, objects, remoteRows, resolution) {
  const base = rowMap(baseRows),
    remote = rowMap(remoteRows);
  const local = new Map(
    objects.map((o) => [o.id, withoutLayoutMeasurement(o)]),
  );
  return [...new Set([...base.keys(), ...local.keys(), ...remote.keys()])]
    .map((id) =>
      mergeData(
        base.get(id) || null,
        local.get(id) || null,
        remote.get(id) || null,
        id,
        resolution,
      ),
    )
    .filter(Boolean);
}
export function changesFor(rows, objects) {
  const base = new Map(rows.map((row) => [row.id, row]));
  const local = new Map(
    objects.map((o) => [o.id, withoutLayoutMeasurement(o)]),
  );
  return [...new Set([...base.keys(), ...local.keys()])]
    .filter(
      (id) =>
        !equal(
          base.get(id)?.deleted
            ? null
            : withoutLayoutMeasurement(base.get(id)?.data) || null,
          local.get(id) || null,
        ),
    )
    .map((id) => ({
      id,
      expectedRevision: base.get(id)?.revision || 0,
      data: local.get(id) || null,
    }));
}
export function undoChanges(before, after, current) {
  const live = new Map(current.map((object) => [object.id, object]));
  const uploaded = (objects) =>
    objects.map((object) => {
      const latest = live.get(object.id);
      // Upload acknowledgement describes the same immutable file; it is not an
      // intervening user edit. Keep every actual image field in conflict checks.
      if (
        object.type === "image" &&
        !object.assetMetadata &&
        latest?.type === "image" &&
        latest.assetId === object.assetId &&
        latest.assetMetadata?.id === object.assetId
      )
        return { ...object, assetMetadata: latest.assetMetadata };
      return object;
    });
  const rows = (objects) =>
    objects.map((data) => ({ id: data.id, data, deleted: false }));
  return reconcile(
    rows(adoptTaskAuthors(uploaded(after), current)),
    adoptTaskAuthors(uploaded(before), current),
    rows(current),
  );
}
