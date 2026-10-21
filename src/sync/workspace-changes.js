import { reconcile } from "./replica.js";
import { sharedObject } from "../../shared/canvas-contract.js";
const rows = (objects) =>
  objects.map((data) => ({ id: data.id, data, deleted: false }));
export function projectObjects(previous, proposed, current) {
  return withLocalLayout(
    reconcile(rows(previous), proposed, rows(current)),
    current,
  );
}
export function withLocalLayout(objects, previous) {
  const measured = new Map(previous.map((o) => [o.id, o.layoutHeight]));
  return objects.map((object) => {
    if (object.type !== "note") return object;
    const height = object.fixedHeight
      ? object.height
      : (object.layoutHeight ?? measured.get(object.id));
    return height === undefined ? object : { ...object, layoutHeight: height };
  });
}
export function transactionBaseAfterRemote(base, beforeLocal, afterRemote) {
  return reconcile(rows(beforeLocal), base, rows(afterRemote), "remote");
}
export function prepareEdit(state) {
  return state.objects.map(sharedObject);
}
export function assetIdsToHydrate(state) {
  return Object.keys(state.assets);
}
