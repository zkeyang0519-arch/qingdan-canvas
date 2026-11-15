import test from "node:test";
import assert from "node:assert/strict";
import { validatePortable } from "../desktop/portable-state.mjs";
const origin = "https://todo.zky.lol";
const fixture = () => ({
  format: "qingdao-portable",
  version: 1,
  origin,
  accountId: "alice",
  drafts: [
    {
      key: "alice/room/desktop-v1",
      value: {
        replica: {
          version: 1,
          base: [],
          objects: [],
          flight: { type: "commit", opId: "offline-op", changes: [] },
        },
        view: { dynamicIsland: { pinned: true } },
      },
    },
  ],
  inputs: [
    {
      key: `qingdan.desktop.input.v1:${JSON.stringify([origin, "alice", "room"])}`,
      value: { project: "尚未提交" },
    },
  ],
  assets: [{ key: "room/image1", type: "image/png", base64: "YWJj" }],
});
test("portable migration retains offline operations, preferences, inputs and assets", () => {
  const v = fixture();
  assert.equal(validatePortable(v, origin, "alice"), v);
  assert.equal(v.drafts[0].value.replica.flight.opId, "offline-op");
});
test("portable migration refuses mixed accounts, origins, assets and duplicate records", () => {
  for (const change of [
    (v) => (v.accountId = "bob"),
    (v) => (v.origin = "https://evil.example"),
    (v) => (v.drafts[0].key = "bob/room/desktop-v1"),
    (v) => (v.assets[0].key = "foreign/image1"),
    (v) => (v.assets[0].base64 = "bad!!"),
    (v) => v.drafts.push(v.drafts[0]),
    (v) => (v.inputs[0].value.project = { secret: true }),
    (v) => (v.drafts[0].value.replica.objects = ["invalid object"]),
    (v) => (v.drafts[0].value.replica.flight.type = "unknown operation"),
  ]) {
    const value = fixture();
    change(value);
    assert.throws(() => validatePortable(value, origin, "alice"));
  }
});
