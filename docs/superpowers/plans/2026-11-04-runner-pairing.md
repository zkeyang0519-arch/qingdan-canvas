# 第 3 步设备绑定 Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for the independent Worker and local Runner units; root owns UI and integration. Each unit writes behavioral tests before implementation. Do not start step 4 execution MCP.

**Goal:** 当前本机版轻单账号配对真实 Windows Runner，登记允许的项目，后台保持连接，并在轻单内完成在线/离线/重连、目录授权和清单绑定体验。

**Architecture:** 浏览器登录创建单次配对码；本机 Runner 在 Credential Manager 保存设备密钥，使用设备凭据换取 15 分钟 token 后主动连接 RunnerHub WebSocket。D1 保存配对、设备和清单绑定；RunnerHub 保存连接 epoch、事件回执和目录租约；本机持久化目录、命令和未 ACK 事件。现有 8790 本机入口增加设备控制 API，复用运行在后台的 Node 进程，浏览器关闭不终止连接。

**Tech Stack:** React 19、Workers/SQLite Durable Objects、D1、Node 24、Windows CredRead/CredWrite、ws。既有依赖版本不升级。

**Spec:** [原设计](../specs/2026-11-03-qingdan-router-design.md)，Task 3；用户已选择当前本机版先验收。

## Constraints / rulings

- 10 分钟配对码、15 分钟连接 token、15 秒心跳、45 秒离线、60 秒执行租约；不自动接管未确认停止的旧运行。
- 设备密钥只能写 Windows Credential Manager；测试用注入的内存凭据存储。密钥不放参数、日志、网页或 JSON 文件。
- HTTP 仅允许明确的 loopback 开发 origin，远程必须 HTTPS；本次只绑定 http://127.0.0.1:8788 服务端，网页入口为 8790。
- 旧连接 epoch 不处理命令或续租；重复命令 ID 返回原回执，换内容拒绝；未 ACK 事件重启补发，已 ACK 不重发。
- 目录 realpath、大小写规范化、Git 工作树根的跨进程锁；子路径检查拒绝前缀混淆、..、junction 逃逸和注册路径替换。
- 项目注册仅本机 UI/CLI 的显式操作；云端或模型不得提交 cwd 或 shell 来获得执行权限。
- 控制入口必须先确认当前轻单登录账号，并与本机设备 ownerId 匹配；所有云端设备/绑定路由同样检查所有者。
- 不提前实现派单；执行命令只做可靠收件与回执基础，保留后续消费者接口。
- Ruling: 沿用干净的 feat/qingdan-mcp 工作分支与既有本机数据；不另建会切断当前体验入口的 checkout。各实现单元有明确文件归属。
- Ruling: 用户选择本机版验收；不部署线上。Windows 开机自启和安装包完善属于第 10 步。本步骤可通过现有启动器加载 Runner，并在关闭网页后继续、重启启动器后恢复。

## Shared HTTP contract (fixed for Worker / Runner / UI)

All responses JSON, errors `{error:string,code?:string}`. Camel case. Browser routes require same-origin, session and X-QD-Account match. Native routes reject browser Origin, use device credentials/Bearer; mount before global browser sameOrigin.

- POST `/api/agent/devices/pairings` body `{}` -> `{pairingId,pairingCode,expiresAt}`. Owner from session, one-time 32 hex code (separators accepted), D1 stores hash only.
- POST `/api/runner/pair` `{pairingCode,runnerId,deviceName,secretHash,expectedOwnerId}` -> `{runnerId,ownerId,authEpoch}`. UUID runnerId, SHA256(secret) hex; expectedOwnerId must equal code owner. Code consumed atomically, repeat use rejects.
- POST `/api/runner/token` `{runnerId,secret}` -> `{token,expiresAt,runnerId,ownerId,authEpoch}`. Random opaque Bearer, hash stored with audience/expiry/epoch; never echo secret.
- GET `/api/runner/connect` Upgrade websocket + Authorization Bearer token, no Origin.
- GET `/api/agent/devices` -> `{enabled:true,devices:DeviceView[]}`. DeviceView `{runnerId,ownerId,deviceName,status:online|offline|revoked,lastSeenAt:string|null,connectionEpoch:number,authEpoch:number,workspaces:WorkspaceView[]}`.
- POST `/api/agent/devices/:runnerId/revoke` `{}` -> `{ok:true}`. Bump authEpoch, invalidate tokens/bindings and close socket immediately.
- GET `/api/agent/bindings?canvasId=...&sectionId=...` -> `{binding:BindingView|null}`. POST `/api/agent/bindings` `{canvasId,sectionId,runnerId,workspaceId,expectedRevision:number|null}` -> `{binding}`. BindingView `{bindingId,ownerId,canvasId,sectionId,runnerId,workspaceId,revision,enabled}`. Initial binding requires canvas owner; updates must match revision and no unconfirmed workspace lease.
- `WorkspaceView` `{workspaceId,name,displayPath,revision,checks:{checkId,label}[]}`; no executable argv in cloud metadata.

## Shared WebSocket contract (fixed)

All packets protocolVersion:1. Runner messages carry connectionEpoch. Server welcome `{type:'welcome',runnerId,connectionEpoch,authEpoch,heartbeatMs:15000,leaseMs:60000,serverTime:number}`.

- Runner `heartbeat {connectionEpoch,leases?:{workspaceId,runId,leaseEpoch}[]}` -> server `heartbeat_ack {connectionEpoch,serverTime,leases:{workspaceId,runId,leaseEpoch,expiresAt:number}[]}`.
- Runner `register_workspaces {connectionEpoch,requestId,workspaces:WorkspaceView[]}` -> `workspaces_ack {connectionEpoch,requestId}`. Full replacement; removed workspaces disable corresponding bindings. Reject removal while active/unconfirmed lease.
- Runner `event {connectionEpoch,event:RunnerEvent}` -> `event_ack {connectionEpoch,eventId}` after durable dedup. Same event ID with different hash rejects.
- Server `command {connectionEpoch,envelope:CommandEnvelope}` -> runner `command_ack {connectionEpoch,commandId,receipt:{status:'stored'|'rejected',reason?:string}}`. Client journals before ACK; consumer is later step. Envelope schema/hash/expiry/authEpoch/leaseEpoch checked; stale connection packet ignored.
- Runner `lease_claim {connectionEpoch,requestId,workspaceId,runId}` -> server `lease_granted {connectionEpoch,requestId,workspaceId,runId,leaseEpoch,expiresAt:number,serverTime:number}`. Expired lease remains occupied until explicit confirmed release.
- Runner `lease_release {connectionEpoch,requestId,workspaceId,runId,leaseEpoch,confirmedStopped:true}` -> `lease_released {connectionEpoch,requestId}`. Lease claim/release are future execution integration primitives, not arbitrary commands.
- Server `revoked {reason}` or `error {code,message,requestId?}`. Auth revocation stops retry; network failure retries with bounded exponential backoff.

## Local controller contract (fixed)

Export `RunnerDeviceController` from runner/index.ts, constructed with `{stateDir,serverOrigin,credentials?}`. `start():Promise<void>` restores existing configuration and connects. `status(ownerId)` returns LocalDeviceView or rejects a different owner.

- `pair({ownerId,pairingCode,deviceName})`, `registerWorkspace(ownerId,{root,name?})`, `removeWorkspace(ownerId,workspaceId)`, `setEnabled(ownerId,enabled)`, `reconnect(ownerId)`, `forget(ownerId)` return current LocalDeviceView.
- `forget` is called after browser endpoint revokes the device; verifies remote revoked/invalid credentials before clearing the specific local credential/config. `close()` stops owned transport/timers, retaining pair and allowed roots.
- LocalDeviceView `{paired,runnerId:string|null,ownerId:string|null,deviceName,serverOrigin,enabled,connectionStatus:'unpaired'|'connecting'|'online'|'offline'|'revoked'|'error',lastHeartbeatAt:string|null,connectionEpoch,workspaces:WorkspaceView[],error:string|null,credentialStorage:'windows-credential-manager'}`.
- Root mounts `/api/local-runner/status`, `/pair`, `/workspaces`, `/workspaces/remove`, `/connection`, `/reconnect`, `/forget`. Root authenticates browser to upstream /api/session, checks X-QD-Account, passes trusted ownerId; request bodies never choose actor.

## Units / ownership and gates

| Unit                    | Files                                                                                                                                                                                                 | Output / verification                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| A Worker                | worker/execution/*, migrations/0007_agent_bindings.sql, worker/index.ts, worker/types.ts, wrangler.jsonc, tests/agent-pairing.test.mjs                                                                | Auth, pairing, Hub, bindings, real workerd/D1 tests                                                  |
| B Local Runner          | runner/{credentials,workspaces,transport,device-store,device-controller,main}.ts + helper ps1, runner/index.ts, scripts/build-runner.mjs, tests/runner-transport.test.mjs and runner-workspaces tests | Credential vault, paths/locks, durable transport, controller; Node subprocess and fake-clock tests   |
| C UI/integration (root) | src/agent/DevicePanel.jsx, AgentExperience.jsx, CSS, scripts/lib/local-runner-api.mjs, existing local server/startup scripts, package.json, docs, UI/bridge/e2e tests                                 | Actual logged-in pairing UI, directory management, cloud binding, background connection and recovery |

- [x] A: failing tests -> implementation -> focused tests/typecheck -> independent review.
- [x] B: failing tests -> implementation -> focused tests/typecheck -> independent review.
- [x] C: failing UI/security tests -> implementation -> focused tests + independent review.
- [x] Real Windows credential round trip, browser pair current account, add test root, bind current list; stop/reconnect, close/reopen page, restart service; record evidence.
- [x] Full tests then typechecks/build/deploy dry run sequentially; independent whole-change review; save changes in the existing local branch.

## Preflight ledger

| Check              | Finding / decision                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| A ↔ B HTTP/WS      | Fixed contracts above; agents must notify root before changing wire names or semantics.                                    |
| A ↔ C browser auth | UI uses existing api() session guard; native routes isolated before global sameOrigin.                                     |
| B ↔ C controller   | Async public contract above; secret never exposed by status, pairing recovery uses saved identity.                         |
| A consistency      | Fresh migration 0007 available; Worker flag RUNNER_ENABLED defaults false, dev launcher enables it.                        |
| B consistency      | Separate device SQLite avoids changing existing RunnerStore v1; global per-user locks must span different stateDir values. |
| C consistency      | Current local account explicitly chosen; no production migration or deployment is needed.                                  |

## Progress ledger

- A/B implemented and independently reviewed. Round 1 fixed three important findings: expired retained leases poisoned heartbeats; epoch-free Hub errors were ignored; local metadata limits differed from Worker. All three independently re-reviewed as addressed; no deferred/parked findings.
- A now has real RunnerTransport + reopened SQLite + workerd regression for a >60s lease outage, healthy heartbeat reconnection with retained occupancy, and immediate real Hub error rejection. B focused tests: 22 passed.
- C focused tests and independent review passed. Real Windows vault round trip passed and its temporary credential was deleted. Browser verified pairing, D:/TODO/qingdan-canvas authorization and current-list binding, disconnect/resume/reconnect, and temporary-project add/remove.
- Page was actually closed: native heartbeat continued and both sides remained online. Restarted local launcher: same runnerId/workspaceId/binding restored; connectionEpoch advanced from 4 to 5 and heartbeat resumed. Service remains running in a hidden background process for user experience.
- Automated approval rejected real-device revocation testing because it would revoke existing device/project/list access; cancelled confirmation and kept the binding. Actual revocation behavior is covered by isolated workerd and controller/UI tests; no attempt to bypass the rejection.
- Full regression passed 545/545. First run hit a sandbox permission error in Wrangler's per-user registry/log directory; rerun with XDG_CONFIG_HOME and WRANGLER_LOG_PATH under the workspace passed. Both typechecks and deploy dry run passed; existing Vite chunk-size/Zod annotation warnings remain.
- Final whole-change review found one release-ACK-loss recovery issue. The final fix persists an exact workspace/run/lease-epoch confirmation before D1 deletion; retries survive Hub and local SQLite restart, and delayed old ACKs preserve newer leases. A real D1 abort + lost-ACK + hibernation/reopen regression reproduced both failures before the fix. Scoped final re-review passed with no remaining findings.
- Final code reran full regression: 545/545; both typechecks, Runner build and deploy dry run passed. Final background service rebuilt and restarted with the same saved device configuration. Changes are retained in the existing local feature branch; no merge, push or production deployment.
