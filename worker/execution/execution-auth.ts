import type { Env } from "../types";
import { digest, token } from "../auth";
import { check } from "../http";
import type { BindingRow, DeviceRow, WorkspaceView } from "./types";
export interface ExecutionPrincipal {
  ownerId: string;
  runnerId: string;
  bindingId: string;
  bindingRevision: number;
  authEpoch: number;
}
export async function authorizeExecution(env: Env, p: ExecutionPrincipal) {
  const binding = await env.DB.prepare(
    "SELECT b.* FROM agent_bindings b JOIN rooms r ON r.id=b.canvas_id WHERE b.binding_id=? AND b.owner_id=? AND r.owner_id=b.owner_id AND b.runner_id=? AND b.revision=? AND b.enabled=1",
  )
    .bind(p.bindingId, p.ownerId, p.runnerId, p.bindingRevision)
    .first<BindingRow>();
  const device = await env.DB.prepare(
    "SELECT * FROM agent_devices WHERE runner_id=? AND owner_id=? AND auth_epoch=? AND revoked_at IS NULL",
  )
    .bind(p.runnerId, p.ownerId, p.authEpoch)
    .first<DeviceRow>();
  check(binding && device, "执行授权已失效。", 403);
  const workspace = (
    JSON.parse(device.workspaces_json) as WorkspaceView[]
  ).find((w) => w.workspaceId === binding.workspace_id);
  check(workspace, "项目未授权。", 403);
  return { binding, device, workspace };
}
export async function bindingPrincipal(
  env: Env,
  ownerId: string,
  bindingId: string,
): Promise<ExecutionPrincipal> {
  const row = await env.DB.prepare(
    "SELECT b.*,d.auth_epoch FROM agent_bindings b JOIN agent_devices d ON d.runner_id=b.runner_id WHERE b.binding_id=? AND b.owner_id=?",
  )
    .bind(bindingId, ownerId)
    .first<BindingRow & { auth_epoch: number }>();
  check(row, "执行绑定不可用。", 403);
  const p = {
    ownerId,
    runnerId: row.runner_id,
    bindingId,
    bindingRevision: row.revision,
    authEpoch: row.auth_epoch,
  };
  await authorizeExecution(env, p);
  return p;
}
export async function mintExecutionToken(env: Env, p: ExecutionPrincipal) {
  await authorizeExecution(env, p);
  const value = token();
  await env.DB.prepare("DELETE FROM agent_execution_tokens WHERE expires_at<?")
    .bind(Date.now())
    .run();
  await env.DB.prepare(
    "INSERT INTO agent_execution_tokens VALUES(?,?,?,?,?,?,'/executor-mcp','manual-trial',?)",
  )
    .bind(
      await digest(value),
      p.ownerId,
      p.runnerId,
      p.bindingId,
      p.bindingRevision,
      p.authEpoch,
      Date.now() + 60000,
    )
    .run();
  return value;
}
export async function executionPrincipal(
  request: Request,
  env: Env,
): Promise<ExecutionPrincipal> {
  const value = request.headers
    .get("Authorization")
    ?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  check(value, "执行凭据无效。", 401);
  const row = await env.DB.prepare(
    "SELECT * FROM agent_execution_tokens WHERE token_hash=? AND audience='/executor-mcp' AND purpose='manual-trial' AND expires_at>?",
  )
    .bind(await digest(value), Date.now())
    .first<{
      owner_id: string;
      runner_id: string;
      binding_id: string;
      binding_revision: number;
      auth_epoch: number;
    }>();
  check(row, "执行凭据无效。", 401);
  const p = {
    ownerId: row.owner_id,
    runnerId: row.runner_id,
    bindingId: row.binding_id,
    bindingRevision: row.binding_revision,
    authEpoch: row.auth_epoch,
  };
  await authorizeExecution(env, p);
  return p;
}
export async function nativePrincipal(request: Request, env: Env) {
  check(
    !request.headers.has("Origin") && !request.headers.has("Sec-Fetch-Site"),
    "设备接口不接受浏览器请求。",
    403,
  );
  const value = request.headers
    .get("Authorization")
    ?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  check(value, "设备凭据无效。", 401);
  const d = await env.DB.prepare(
    "SELECT d.* FROM agent_connection_tokens t JOIN agent_devices d ON d.runner_id=t.runner_id WHERE t.token_hash=? AND t.audience='runner-connect' AND t.expires_at>? AND t.auth_epoch=d.auth_epoch AND d.revoked_at IS NULL",
  )
    .bind(await digest(value), Date.now())
    .first<DeviceRow>();
  check(d, "设备凭据无效。", 401);
  return d;
}
