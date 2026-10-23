import test from "node:test";
import assert from "node:assert/strict";
import {
  createObject,
  makeBlock,
  validateWorkspace,
  createWorkspace,
} from "../src/canvas/model.js";
import { sharedObject } from "../shared/canvas-contract.js";
import {
  attributeLocalBlocks,
  rememberTaskAuthors,
  taskAuthorKey,
} from "../shared/task-authors.js";
import { RoomReplica } from "../src/sync/room-client.js";
import { undoChanges } from "../src/sync/replica.js";

const alice = { id: "alice", name: "小张" };
const bob = { id: "bob", name: "小李" };
const note = () => ({
  ...createObject("room", "note", { x: 0, y: 0 }),
  noteKind: "checklist",
  blocks: [makeBlock("准备资料")],
});
const row = (data, revision = 1) => ({
  id: data.id,
  data,
  revision,
  deleted: false,
});

test("新建、复制、多行粘贴归当前用户，编辑和恢复保留原作者，旧条目不补猜作者", () => {
  const known = new Map();
  const legacy = note();
  rememberTaskAuthors([legacy], known);
  const added = note();
  let objects = attributeLocalBlocks([legacy, added], alice, known);
  assert.equal(objects[0].blocks[0].createdByUserId, undefined);
  assert.equal(objects[1].blocks[0].createdByUserId, alice.id);
  rememberTaskAuthors(objects, known);
  const pasted = [makeBlock("第二行"), makeBlock("第三行")];
  const edited = {
    ...objects[1],
    blocks: [
      {
        ...objects[1].blocks[0],
        done: true,
        completedAt: new Date().toISOString(),
        createdByUserId: bob.id,
      },
      ...pasted,
    ],
  };
  objects = attributeLocalBlocks([edited], bob, known);
  assert.deepEqual(
    objects[0].blocks.map((b) => b.createdByUserId),
    [alice.id, bob.id, bob.id],
  );
  const copied = {
    ...objects[0],
    id: "copy",
    blocks: objects[0].blocks.map((b) => ({ ...b, id: crypto.randomUUID() })),
  };
  assert.ok(
    attributeLocalBlocks([copied], bob, known)[0].blocks.every(
      (b) => b.createdByUserId === bob.id,
    ),
  );
  assert.equal(
    attributeLocalBlocks([added], bob, known)[0].blocks[0].createdByUserId,
    alice.id,
  );
  assert.notEqual(taskAuthorKey("a/b", "c"), taskAuthorKey("a", "b/c"));
});

test("共享契约和备份保留作者，兼容旧数据，拒绝无效作者字段", () => {
  const data = attributeLocalBlocks([note()], alice, new Map())[0];
  const clean = sharedObject(data);
  assert.equal(clean.blocks[0].createdByUserId, alice.id);
  assert.equal(clean.blocks[0].createdByName, alice.name);
  const state = createWorkspace();
  state.objects = [{ ...clean, boardId: state.boards[0].id }];
  assert.doesNotThrow(() =>
    validateWorkspace(JSON.parse(JSON.stringify(state))),
  );
  assert.equal(sharedObject(note()).blocks[0].createdByUserId, undefined);
  for (const invalid of [42, "", "x".repeat(257)]) {
    assert.throws(() =>
      sharedObject({
        ...data,
        blocks: [{ ...data.blocks[0], createdByUserId: invalid }],
      }),
    );
  }
  assert.throws(() =>
    sharedObject({
      ...data,
      blocks: [{ ...data.blocks[0], createdByName: 42 }],
    }),
  );
});

test("服务端作者确认保留后续输入，不触发重复提交，也不阻碍撤销新增", () => {
  const sent = [];
  const r = new RoomReplica(
    null,
    (m) => sent.push(m),
    () => {},
  );
  r.receive({ type: "snapshot", rows: [] });
  const draft = note();
  r.edit([draft]);
  r.flush();
  const canonical = sharedObject(
    attributeLocalBlocks([draft], alice, new Map())[0],
  );
  r.edit([
    {
      ...draft,
      blocks: [
        { ...draft.blocks[0], runs: [{ type: "text", text: "继续输入" }] },
      ],
    },
  ]);
  r.receive({ type: "ack", opId: sent[0].opId, rows: [row(canonical)] });
  assert.equal(r.objects[0].blocks[0].createdByUserId, alice.id);
  assert.equal(r.objects[0].blocks[0].runs[0].text, "继续输入");
  r.flush();
  r.receive({
    type: "ack",
    opId: sent[1].opId,
    rows: [row(sharedObject(sent[1].changes[0].data), 2)],
  });
  assert.equal(r.dirty, false);
  assert.deepEqual(undoChanges([], [draft], [canonical]), []);
  const modified = {
    ...canonical,
    blocks: [
      { ...canonical.blocks[0], runs: [{ type: "text", text: "别人的输入" }] },
    ],
  };
  assert.throws(() => undoChanges([], [draft], [modified]));
});

test("服务端纠正过期昵称后客户端安静同步，无后续输入也不会反复保存", () => {
  const sent = [];
  const r = new RoomReplica(
    null,
    (m) => sent.push(m),
    () => {},
  );
  r.receive({ type: "snapshot", rows: [] });
  const draft = sharedObject(
    attributeLocalBlocks([note()], alice, new Map())[0],
  );
  r.edit([draft]);
  r.flush();
  const canonical = sharedObject({
    ...draft,
    blocks: draft.blocks.map((b) => ({ ...b, createdByName: "张三" })),
  });
  r.receive({ type: "ack", opId: sent[0].opId, rows: [row(canonical)] });
  assert.equal(r.objects[0].blocks[0].createdByName, "张三");
  assert.equal(r.dirty, false);
  r.flush();
  assert.equal(sent.length, 1);
  assert.deepEqual(undoChanges([], [draft], r.objects), []);
});
