export interface WorkspaceView {
  workspaceId: string;
  name: string;
  displayPath: string;
  revision: number;
  checks: { checkId: string; label: string }[];
}
export interface DeviceRow {
  runner_id: string;
  owner_id: string;
  device_name: string;
  secret_hash: string;
  auth_epoch: number;
  revoked_at: number | null;
  last_seen_at: number | null;
  connection_epoch: number;
  workspaces_json: string;
}
export interface BindingRow {
  binding_id: string;
  owner_id: string;
  canvas_id: string;
  section_id: string;
  runner_id: string;
  workspace_id: string;
  revision: number;
  enabled: number;
}
export const bindingView = (b: BindingRow) => ({
  bindingId: b.binding_id,
  ownerId: b.owner_id,
  canvasId: b.canvas_id,
  sectionId: b.section_id,
  runnerId: b.runner_id,
  workspaceId: b.workspace_id,
  revision: b.revision,
  enabled: !!b.enabled,
});
