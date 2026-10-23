import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { recoverTaskAuthorsFromReceipts } from "../worker/task-author-recovery.js";
import { createObject, makeBlock } from "../src/canvas/model.js";
import { sharedObject } from "../shared/canvas-contract.js";
import { withTaskAuthor } from "../shared/task-authors.js";
import { RoomReplica } from "../src/sync/room-client.js";

test("完整历史恢复每条待办的最初作者，重写和恢复不变更作者，缺失历史不猜测", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE receipts(id TEXT PRIMARY KEY,user_id TEXT,payload TEXT,value TEXT);
    CREATE TABLE task_authors(note_id TEXT,block_id TEXT,value TEXT,PRIMARY KEY(note_id,block_id));
  `);
  const sql = {
    exec(query, ...args) {
      const rows = db.prepare(query).all(...args);
      rows.toArray = () => rows;
      return rows;
    },
  };
  let receiptNumber = 0;
  const add = (id, revision, userId, blocks) => {
    const data =
      blocks === null
        ? null
        : {
            id,
            type: "note",
            blocks: blocks.map((blockId) => ({ id: blockId })),
          };
    const receipt = {
      type: "ack",
      rows: [{ id, revision, deleted: data === null, data }],
    };
    db.prepare("INSERT INTO receipts VALUES(?,?,?,?)").run(
      String(++receiptNumber),
      userId,
      "[]",
      JSON.stringify(receipt),
    );
  };
  // Deliberately insert out of order: database row order is not creation order.
  add("complete", 3, "bob", ["first", "second"]); // rewrite by Bob
  add("complete", 1, "alice", ["first"]);
  add("complete", 2, "bob", ["first", "second"]);
  add("complete", 4, "bob", ["second"]);
  add("complete", 5, "bob", ["second", "first"]); // restore by Bob
  add("deleted", 1, "alice", ["deleted-task"]);
  add("deleted", 2, "bob", null);
  add("missing-start", 6, "bob", ["unknown"]);
  add("gap", 1, "alice", ["known"]);
  add("gap", 3, "bob", ["known", "unproven"]);
  add("gap", 4, "bob", ["known", "unproven", "later"]);
  add("recorded", 1, "bob", ["keep-author"]);
  for (const [noteId, blockId, value] of [
    ["complete", "first", {}],
    ["complete", "second", {}],
    ["missing-start", "unknown", {}],
    ["gap", "unproven", {}],
    [
      "recorded",
      "keep-author",
      { createdByUserId: "original", createdByName: "原作者" },
    ],
  ])
    db.prepare("INSERT INTO task_authors VALUES(?,?,?)").run(
      noteId,
      blockId,
      JSON.stringify(value),
    );
  const receipts = db.prepare("SELECT * FROM receipts ORDER BY id").all();
  recoverTaskAuthorsFromReceipts(sql);
  const author = (noteId, blockId) => {
    const row = db
      .prepare("SELECT value FROM task_authors WHERE note_id=? AND block_id=?")
      .get(noteId, blockId);
    return row ? JSON.parse(row.value) : {};
  };
  assert.equal(author("complete", "first").createdByUserId, "alice");
  assert.equal(author("complete", "second").createdByUserId, "bob");
  assert.equal(author("deleted", "deleted-task").createdByUserId, "alice");
  assert.equal(author("gap", "known").createdByUserId, "alice");
  assert.deepEqual(author("missing-start", "unknown"), {});
  assert.deepEqual(author("gap", "unproven"), {});
  assert.deepEqual(author("gap", "later"), {});
  assert.deepEqual(author("recorded", "keep-author"), {
    createdByUserId: "original",
    createdByName: "原作者",
  });
  assert.deepEqual(
    db.prepare("SELECT * FROM receipts ORDER BY id").all(),
    receipts,
    "原回执不能改写",
  );
  const records = db
    .prepare("SELECT * FROM task_authors ORDER BY note_id,block_id")
    .all();
  recoverTaskAuthorsFromReceipts(sql);
  assert.deepEqual(
    db.prepare("SELECT * FROM task_authors ORDER BY note_id,block_id").all(),
    records,
  );
  db.close();
});

test("旧待办收到恢复的作者信息后保留本地文字，重连不产生额外修改", () => {
  const old = sharedObject({
    ...createObject("room", "note"),
    blocks: [makeBlock("原文字")],
  });
  const row = (data) => ({ id: data.id, revision: 12, deleted: false, data });
  const canonical = sharedObject({
    ...old,
    blocks: old.blocks.map((block) =>
      withTaskAuthor(block, { createdByUserId: "alice" }),
    ),
  });
  const replica = new RoomReplica(
    { base: [row(old)], objects: [old] },
    () => {},
    () => {},
  );
  replica.receive({ type: "snapshot", rows: [row(canonical)] });
  assert.equal(replica.objects[0].blocks[0].createdByUserId, "alice");
  assert.equal(replica.dirty, false);
  const local = structuredClone(old);
  local.blocks[0].runs = [{ type: "text", text: "重写的文字" }];
  const edited = new RoomReplica(
    { base: [row(old)], objects: [local] },
    () => {},
    () => {},
  );
  edited.receive({ type: "snapshot", rows: [row(canonical)] });
  assert.equal(edited.conflict, null);
  assert.equal(edited.objects[0].blocks[0].createdByUserId, "alice");
  assert.equal(edited.objects[0].blocks[0].runs[0].text, "重写的文字");
});
