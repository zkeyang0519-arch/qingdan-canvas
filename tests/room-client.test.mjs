import test from "node:test";
import assert from "node:assert/strict";
import { RoomReplica } from "../src/sync/room-client.js";
const row = (x = 0, revision = 1) => ({
  id: "n1",
  revision,
  deleted: false,
  data: { id: "n1", x, y: 0 },
});
function harness(saved) {
  const sent = [];
  const replica = new RoomReplica(
    saved,
    (message) => sent.push(message),
    () => {},
  );
  return { replica, sent };
}
test("飞行中的操作被确认后仍保留后来输入", () => {
  const { replica: r, sent } = harness();
  r.receive({ type: "snapshot", rows: [row()] });
  r.edit([{ ...row().data, x: 10 }]);
  r.flush();
  r.edit([{ ...row().data, x: 20 }]);
  r.receive({ type: "ack", opId: sent[0].opId, rows: [row(10, 2)] });
  r.flush();
  assert.equal(r.objects[0].x, 20);
  assert.equal(sent[1].changes[0].expectedRevision, 2);
});
test("刷新重连重发完全相同操作且确认后不回退", () => {
  const first = harness();
  first.replica.receive({ type: "snapshot", rows: [row()] });
  first.replica.edit([{ ...row().data, x: 10 }]);
  first.replica.flush();
  const restored = harness(JSON.parse(JSON.stringify(first.replica.save())));
  restored.replica.receive({ type: "snapshot", rows: [row(10, 2)] });
  assert.deepEqual(restored.sent[0], first.sent[0]);
  restored.replica.receive({
    type: "ack",
    opId: first.sent[0].opId,
    rows: [row(10, 2)],
  });
  assert.equal(restored.replica.objects[0].x, 10);
  assert.equal(restored.replica.dirty, false);
});
test("版本竞争自动合并不同字段并重新提交", () => {
  const { replica: r, sent } = harness();
  r.receive({ type: "snapshot", rows: [row()] });
  r.edit([{ ...row().data, x: 10 }]);
  r.flush();
  const remote = { ...row(0, 2), data: { ...row().data, y: 20 } };
  r.receive({ type: "conflict", opId: sent[0].opId, rows: [remote] });
  r.flush();
  assert.equal(r.objects[0].x, 10);
  assert.equal(r.objects[0].y, 20);
  assert.equal(sent[1].changes[0].expectedRevision, 2);
});
test("冲突处理只选择冲突字段，保留其它远端修改", () => {
  const { replica: r, sent } = harness();
  r.receive({ type: "snapshot", rows: [row()] });
  r.edit([{ ...row().data, x: 10 }]);
  r.flush();
  const remote = { ...row(30, 2), data: { ...row(30).data, y: 20 } };
  r.receive({ type: "conflict", opId: sent[0].opId, rows: [remote] });
  assert.ok(r.conflict);
  assert.equal(r.objects[0].x, 10);
  r.resolve("local");
  assert.equal(r.objects[0].x, 10);
  assert.equal(r.objects[0].y, 20);
});
test("未同步时收到过期广播不会回退版本", () => {
  const { replica: r } = harness();
  r.receive({ type: "snapshot", rows: [row(30, 3)] });
  r.receive({ type: "changes", rows: [row(10, 2)] });
  assert.equal(r.objects[0].x, 30);
});
test("暂时保存失败后重试必须重新发送原飞行操作", () => {
  let fail = true;
  const actual = [];
  const r = new RoomReplica(
    null,
    (message) => {
      if (fail) throw Error("disk");
      actual.push(message);
    },
    () => {},
  );
  r.receive({ type: "snapshot", rows: [row()] });
  r.edit([{ ...row().data, x: 10 }]);
  assert.throws(() => r.flush(), /disk/);
  const flight = r.flight;
  fail = false;
  r.retry();
  assert.deepEqual(actual, [flight]);
});

test("旧画布中的自动高度差异不会产生冲突或反复写回", () => {
  const { replica: r, sent } = harness();
  const original = {
    ...row(),
    data: { ...row().data, type: "note", layoutHeight: 190 },
  };
  r.receive({ type: "snapshot", rows: [original] });
  r.edit([{ ...original.data, layoutHeight: 212 }]);
  r.receive({
    type: "changes",
    rows: [
      {
        ...original,
        revision: 2,
        data: { ...original.data, layoutHeight: 230 },
      },
    ],
  });
  assert.equal(r.conflict, null);
  assert.equal(r.dirty, false);
  r.flush();
  assert.deepEqual(sent, []);
});

test("旧草稿未确认操作仍原样重传，高度缓存不影响确认后的同步状态", () => {
  const original = {
    ...row(),
    data: { ...row().data, type: "note", layoutHeight: 190 },
  };
  const edited = { ...original.data, x: 10, layoutHeight: 212 };
  const flight = {
    type: "commit",
    opId: "legacy-resize",
    changes: [{ id: "n1", expectedRevision: 1, data: edited }],
  };
  const { replica: r, sent } = harness({
    base: [original],
    objects: [{ ...edited, layoutHeight: 230 }],
    flight,
  });
  const remote = { ...original, revision: 2, data: edited };
  r.receive({ type: "snapshot", rows: [remote] });
  assert.deepEqual(sent, [flight]);
  r.receive({ type: "ack", opId: flight.opId, rows: [remote] });
  assert.equal(r.objects[0].x, 10);
  assert.equal(r.dirty, false);
});
