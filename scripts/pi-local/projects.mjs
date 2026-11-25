// Local Pi projects use the pilot's own device and D1, including the original
// pi-preview binding. The same binding key scopes chats and MCP selections.
export async function localProjects(db, sample) {
  const rows = await db
    .prepare(
      `SELECT b.section_id AS id,
    json_extract(w.value,'$.name') AS title FROM agent_bindings b
    JOIN agent_devices d ON d.runner_id=b.runner_id, json_each(d.workspaces_json) w
    WHERE b.owner_id='pi-local' AND b.canvas_id='pi-local-room' AND b.enabled=1
    AND d.runner_id='pi-local-runner' AND json_extract(w.value,'$.workspaceId')=b.workspace_id
    ORDER BY b.rowid`,
    )
    .all();
  return rows.results.map((row) => ({
    ...row,
    title:
      row.id === "pi-preview"
        ? sample
          ? "参考图联调"
          : "本机短片试用"
        : row.title,
    tasks: [],
  }));
}

export async function hasLocalBinding(db, id) {
  if (typeof id !== "string") return false;
  return !!(await db
    .prepare(
      `SELECT 1 FROM agent_bindings WHERE binding_id=? AND
    owner_id='pi-local' AND canvas_id='pi-local-room' AND runner_id='pi-local-runner' AND enabled=1`,
    )
    .bind(id)
    .first());
}

export async function createLocalProject(db, { id, name }) {
  if (
    typeof name !== "string" ||
    !name.trim() ||
    name.trim().length > 120 ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id)
  )
    throw Error("项目名称或编号无效。");
  const workspace = {
    workspaceId: id,
    name: name.trim(),
    displayPath: name.trim(),
    revision: 1,
    checks: [],
  };
  await db.batch([
    db
      .prepare(
        `UPDATE agent_devices SET workspaces_json=json_insert(workspaces_json,'$[#]',json(?))
      WHERE runner_id='pi-local-runner' AND NOT EXISTS(SELECT 1 FROM json_each(workspaces_json)
      WHERE json_extract(value,'$.workspaceId')=?)`,
      )
      .bind(JSON.stringify(workspace), id),
    db
      .prepare(
        `INSERT OR IGNORE INTO agent_bindings VALUES(?,'pi-local','pi-local-room',?,
      'pi-local-runner',?,1,1)`,
      )
      .bind("pi-bind-" + id, id, id),
  ]);
  return { id, title: name.trim(), tasks: [] };
}
