import { taskAuthor } from "../shared/task-authors.js";

// Called inside the room's schema transaction. Receipts are immutable evidence:
// only an uninterrupted history from revision 1 proves who introduced a block.
export function recoverTaskAuthorsFromReceipts(sql) {
  sql.exec("CREATE TABLE IF NOT EXISTS room_migrations(name TEXT PRIMARY KEY)");
  const migration = "task-authors-from-receipts-v1";
  if (
    sql
      .exec("SELECT name FROM room_migrations WHERE name=?", migration)
      .toArray().length
  )
    return;
  let noteId = null,
    revision = 0,
    complete = true;
  let seen = new Set();
  for (const entry of sql.exec(`
    SELECT receipts.user_id, history.value AS row_json
    FROM receipts, json_each(receipts.value,'$.rows') AS history
    ORDER BY json_extract(history.value,'$.id'), json_extract(history.value,'$.revision')
  `)) {
    const row = JSON.parse(entry.row_json);
    if (row.id !== noteId) {
      noteId = row.id;
      revision = 0;
      complete = true;
      seen = new Set();
    }
    if (row.revision !== revision + 1) complete = false;
    revision = row.revision;
    if (!complete || row.deleted || row.data?.type !== "note") continue;
    for (const block of row.data.blocks) {
      if (seen.has(block.id)) continue;
      seen.add(block.id);
      const author = block.createdByUserId
        ? taskAuthor(block)
        : { createdByUserId: entry.user_id };
      sql.exec(
        `
        INSERT INTO task_authors(note_id,block_id,value) VALUES(?,?,?)
        ON CONFLICT(note_id,block_id) DO UPDATE SET value=excluded.value
        WHERE json_extract(task_authors.value,'$.createdByUserId') IS NULL
      `,
        row.id,
        block.id,
        JSON.stringify(author),
      );
    }
  }
  sql.exec("INSERT INTO room_migrations(name) VALUES(?)", migration);
}
