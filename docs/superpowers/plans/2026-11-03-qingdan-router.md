# 轻单 Router 与本地 Codex Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现选定本地项目、独立会话总结、记忆聊天、生成排序待办、按批次在同一 Codex 会话依次执行并验收后自动推进的闭环。用户后续确认：一次提交为一个批次，下一次提交再新建会话，暂不处理侧栏归组。

**Architecture:** Cloudflare RouterAgent 处理聊天与记忆，ProjectQueue 以持久化状态机推进任务。执行网关提供异步 MCP，Windows Runner 主动连接云端并通过本地 app-server 创建会话；CanvasRoom 保持清单权威数据。

**Tech Stack:** 现有 React 19、Workers、SQLite Durable Objects、D1、R2；agents 0.30.1；MCP client/server 2.3.1；Zod 4；Node.js 24；Codex app-server 固定版本。

**Spec:** [完整设计](D:/TODO/qingdan-canvas/docs/superpowers/specs/2026-11-03-qingdan-router-design.md)。本文件所有相对源码路径均以 `D:/TODO/qingdan-canvas` 为根。截至 2026-11-05 已按用户后续确认的范围完成 Task 1–10 的本机版本。第8步沿用同批次同会话及现有 RunnerHub 队列，第9步整合为正式工作区，第10步完成安装、诊断与恢复验收。实际范围、验收和剩余限制以[第八步验收](../../agent-batch-queue-verification-2026-11-05.md)、[第九步验收](../../agent-workspace-verification-2026-11-05.md)和[第十步验收](../../agent-install-recovery-verification-2026-11-05.md)为准，原计划细项不代表未经执行的能力已完成。操作入口见 [体验说明](../../agent-experience.md)。早期验证记录见 [任务规则](../../agent-task-rules.md)、[本机 Codex 验收](../../agent-codex-compatibility.md)、[设备绑定验收](../../agent-device-verification-2026-11-04.md) 与 [MCP 派单验收](../../agent-execution-verification-2026-11-04.md)。

## Global Constraints

- 用户补充验收标准（2026-11-03）：每一步完成时，必须在轻单里提供可操作入口、可观察结果和体验步骤，不能仅交付接口或测试脚本。第 9 步改为整合、完善已有界面。第 1/2 步的入口补齐见 [体验计划](2026-11-03-agent-experience.md)。
- 后续 Task 3–10 完成前，逐项落实 [各步骤界面验收表](../../agent-experience.md#后续每一步的界面验收)，并记录页面实测结果。
- 总结独立新建会话；同一次提交的所有待办在同一会话按顺序执行，下一次提交新建会话；批次内澄清、修复和恢复沿用其会话。本规则按用户后续确认更新，优先于早期设计中的逐项新会话描述。
- 绑定本机项目目录，workspaceId 由本机注册；模型不能指定任意 cwd 或伪造账号。
- 初始使用 Node.js 24 系列；本机基线为 24.18.0、Codex CLI 0.166.0-alpha.5.1。先通过真机验证再固定安装与生成类型。
- 沿用 agents 0.30.1 / MCP client 2.3.1 / MCP server 2.3.1；不附带大版本升级。
- 每次最多生成 50 条；每绑定一个活动批次；每台设备默认并发 1；同目录始终并发 1。
- 心跳 15 秒、离线展示 45 秒、执行租约 60 秒；配对码 10 分钟；连接凭证 15 分钟。
- 总结上限 5 分钟、任务上限 30 分钟；同一任务自动修复最多 1 次；未知启动结果不自动重发。
- Router 每轮最多 6 个工具步骤；输入最多 48,000 字符；最多注入 12 条长期记忆，每条最多 1,000 字符。
- CanvasRoom 对象版本、作者信息、同步和操作回执必须保留；前端 update 必须提供 source。
- 所有网络重试都复用原请求身份；业务写回失败只重试写回，不重跑 Codex。
- 初始 AGENT_ENABLED=false、EXECUTION_ENABLED=false；生产部署由用户手工进行，先迁移 D1 再发布。
- 只读总结与工作目录写入按各自权限运行；保留项目 AGENTS.md；不默认绕过审批或沙箱。
- 测试使用独立 workerd 和临时数据库；不读取或改写生产数据；真实 Codex 测试使用明确指定的测试目录。

## Review Focus

- Windows 目录别名和 D:/project-evil 前缀不能获得 D:/project 的权限；Task 3 验证。
- 修改同一便签的另一个块不能阻止合法完成，也不能使已变化的当前任务被误勾选；Task 5/8 验证。
- turn/start 已发送但回复丢失，重启不得再次执行同一任务；Task 2/10 验证。
- 用户在另一个标签页切换项目或协作者改任务，正在运行的队列不能改目标或采用未授权规格；Task 8/9 验证。
- 删除记忆后，旧摘要不能把该记忆重新注入；Task 6 验证派生摘要失效和重建。

## 文件结构与公共接口

| 路径 | 职责 |
| --- | --- |
| shared/agent/contracts.ts、schemas.ts | ID、DTO、状态、Zod 输入与结果契约 |
| shared/agent/sort-plan.ts | 稳定拓扑排序和手工排序验证 |
| worker/agent/router.ts、model.ts、chat-store.ts | Router DO、模型端口、可靠聊天记录 |
| worker/agent/memory.ts、context.ts | 记忆版本、检索、遗忘和上下文包 |
| worker/agent/canvas-service.ts、canvas-store.ts、route.ts | AgentActor 鉴权、CanvasRoom 事务、浏览器 API |
| worker/execution/project-queue.ts、queue-reducer.ts、outbox.ts | 初始化、运行状态机、可靠投递 |
| worker/execution/runner-hub.ts、mcp-server.ts、auth.ts、bindings.ts | 设备连接、执行 MCP、执行凭证和项目绑定 |
| worker/execution/verification.ts、artifacts.ts | 验收判定和附件引用 |
| runner/codex-client.ts、codex-adapter.ts、supervisor.ts | JSON-RPC、按运行创建/恢复线程、受管进程 |
| runner/store.ts、workspaces.ts、credentials.ts、transport.ts、main.ts、verification.ts | 本地持久化、目录授权、配对、WSS、入口和检查命令 |
| src/agent/AgentPanel.jsx、ProjectPicker.jsx、MemoryPanel.jsx、TaskRunCard.jsx、useAgentChat.js、agent.css | 对话、项目、记忆与执行 UI |
| migrations/0007_agent_bindings.sql | 设备和项目绑定；编码前再次检查编号是否已被其他工作占用 |
| tests/fixtures/agent-fixtures.mjs、fake-codex.mjs | 合成数据、模拟 app-server 进程与可控故障注入 |

公共类型统一使用 camelCase，禁止后续任务另造 task_id/thread_id 版本的内部结构。与既有 MCP snake_case 参数只在适配层转换。

```ts
type TaskRef = { canvasId: string; noteId: string; taskId: string };
type AcceptanceCriterion =
  | { id: string; description: string; required: boolean; kind: 'command'; checkId: string }
  | { id: string; description: string; required: boolean; kind: 'artifact'; relativePath: string; predicate: ArtifactPredicate }
  | { id: string; description: string; required: boolean; kind: 'human' };
type RunKind = 'summary' | 'task';
type RunOutcome = {
  runId: string; taskId: string | null;
  outcome: 'done' | 'blocked' | 'needs_input' | 'failed';
  summary: string; changedFiles: string[]; evidenceRefs: string[];
  remainingIssues: string[]; nextTaskNotes: string[];
};
```

Task 1 补全设计第 7 节记录为唯一类型定义，并定义 ArtifactPredicate 为 `{type:'exists'}` / `{type:'jsonSchema',schema:JsonSchema}` / `{type:'textContains',text:string}` 三种结构。第一版 projectId 等于 bindingId。ProjectSummary 使用设计第 4 节结构，与 RunOutcome 分开；summary 运行完成不触发待办勾选。测试夹具统一提供 makeTask、makeBinding、makeSnapshot、makeRunnerEvent、makeQueueState，字段只采用 contracts.ts 的名字。

## Task 1: 契约、状态和排序算法

**Files:** 新增 shared/agent/contracts.ts、schemas.ts、sort-plan.ts、errors.ts、deadlines.ts、tests/agent-contracts.test.mjs、tests/agent-sort.test.mjs、tests/fixtures/agent-fixtures.mjs、docs/agent-task-rules.md；修改 tsconfig.json 纳入共享类型检查，package.json 增加 test:agent，README.md 链接规则说明。

**Interfaces:** 输入为 unknown 或 readonly PlanTask[]。输出 parseAgentCommand(value): AgentCommand、parseRunnerEvent(value): RunnerEvent、parseRunOutcome(value): RunOutcome、sortPlan(tasks, explicitOrder?): string[]、validateManualOrder(tasks, order): void。RunStatus、BatchStatus、AgentActor、ExecutionSnapshot、CommandEnvelope、EventEnvelope、PlanSnapshot、MemoryRecord 在 contracts.ts 定义。

- [x] 写契约测试：拒绝第 51 条、重复 taskId、未知依赖、伪造 actor/cwd；协议版本只接受 1；相同任务标题不等于相同任务 ID。
- [x] 写排序测试：输入 A 依赖 B，即使 A 优先级更高，输出也先 B；同优先级和日期维持原序；手工合法顺序保持；环返回涉及的 IDs；Asia/Shanghai 相对日期与 UTC 存储换算一致。
- [x] 运行 `node --test tests/agent-contracts.test.mjs tests/agent-sort.test.mjs`，记录缺失实现导致的失败。
- [x] 实现严格 schemas、错误码和稳定拓扑排序；错误码统一含 DEPENDENCY_CYCLE、DEPENDENCY_MISSING、REVISION_CONFLICT、IDEMPOTENCY_KEY_REUSED、ACCESS_DENIED、RECONCILIATION_REQUIRED。
- [x] 重跑上述测试并运行 `npm run check`，要求退出码 0；提交仅本任务文件。

验收：专项 26/26、完整回归 478/478、TypeScript 检查、部署 dry run 均通过；独立代码审查通过。受限环境使用项目 `.tmp/wrangler-logs`，解决旧集成测试因 Wrangler 全局日志写入被拒而解析 JSON 失败的问题。未启动 Task 2，未部署。

排序核心断言：

```js
assert.deepEqual(sortPlan([A_depends_on_B, B]), ['B', 'A']);
assert.throws(() => sortPlan([A_depends_on_B, B_depends_on_A]), { code: 'DEPENDENCY_CYCLE' });
```

## Task 2: Codex 本地适配与协议验证

**Files:** 新增 runner/package.json、runner/tsconfig.json、runner/codex-client.ts、codex-adapter.ts、store.ts、supervisor.ts；scripts/build-runner.mjs、scripts/agent-codex-smoke.mjs；tests/runner-codex.test.mjs、tests/fixtures/fake-codex.mjs、docs/agent-codex-compatibility.md。修改根 package.json 增加 runner 构建脚本。

实际补充文件：runner/types.ts、errors.ts、workspace.ts、prompt.ts、process-cleanup.ts、index.ts、protocol-version.json、package-lock.json 与 protocol/ 生成声明；scripts/generate-codex-protocol.mjs；docs/agent-codex-smoke-2026-11-03.json。Node 类型依赖单独安装在 runner 中，未升级根项目依赖。

**Interfaces:** CodexAdapter.startFreshRun(snapshot: ExecutionSnapshot): Promise<LaunchResult>；continueRun(input: ContinueRunInput): Promise<CommandReceipt>；cancelRun(runId): Promise<CommandReceipt>；reconcileRun(runId): Promise<ReconcileResult>；events(): AsyncIterable<RunnerEvent>。LaunchResult 是 started(threadId,turnId) 或 reconciliation_required，不能用一个泛化超时错误驱动自动重试。

- [x] 建立可控 fake-codex：可在 thread/start 响应前、turn/start 接收后、turn/completed 发送后退出，支持分页历史和重复事件。
- [x] 写测试：summary、任务 A、任务 B 调用 startFreshRun 得到不同 threadId、同 cwd；同任务 continue 保留原 threadId；先保存 threadId 再发送 turn；无已知 turn 映射的 completed 不推进状态。
- [x] 运行 `node --test tests/runner-codex.test.mjs` 验证失败。
- [x] 实现 stdio JSONL、initialize 握手、固定 CLI 类型生成、响应关联、输入/审批请求、保存 launchIntent、分页对账。Runner SQLite 用 Node 24 的 node:sqlite，写命令映射采用事务；数据库版本使用 PRAGMA user_version，升级不删旧记录。
- [x] 实现受管进程收尾：中断后查询确认，超时保留待核实；只终止自己拥有的进程树。
- [x] 测试通过后运行构建；执行只读协议能力检查并记录版本。
- [x] 在明确选定的测试目录运行 `node scripts/agent-codex-smoke.mjs --workspace <测试目录> --mode new-threads`：总结 + 两个简单合成任务，保存三个不同 threadId、cwd、turn 终态、桌面可见性和实际验证证据。该步骤会调用真实 Codex，执行时遵循当时的授权与登录流程。
- [x] 更新兼容性记录并提交本任务文件。真实接口不支持时保持执行开关关闭，报告具体缺口，不能用 fake 结果替代。

验收：本地 Runner 25 项测试、完整回归 503/503、根项目与 Runner 类型检查、Runner 构建及部署 dry run 通过。真实三会话与两个文件内容验证通过；桌面历史中可查到三个会话。最终构建重放同一批次后 runId/threadId/turnId 均不变，没有额外执行。独立审查发现的终态竞争、取消意图、恢复回执、订阅恢复及收尾问题均已增加回归测试并修复。Task 3 未启动，未部署。

## Task 3: 设备配对、工作目录与可靠连接

**Files:** 新增 runner/workspaces.ts、credentials.ts、transport.ts、main.ts；worker/execution/auth.ts、bindings.ts、runner-hub.ts；migrations/0007_agent_bindings.sql；tests/runner-transport.test.mjs、tests/agent-pairing.test.mjs。修改 worker/types.ts、worker/index.ts、wrangler.jsonc 连接新路由和 RunnerHub binding。

**Interfaces:** registerWorkspace(root, checks): RegisteredWorkspace；resolveWorkspace(workspaceId): Workspace；claimWorkspace(workspaceId, runId, epoch): LeaseResult；RunnerStore.acceptCommand(envelope): CommandReceipt；RunnerStore.appendEvent(event): number；pairDevice(input, browserActor): PairingResult；verifyDeviceToken(token): DevicePrincipal。

- [x] 写测试：10 分钟后配对码失效、重复使用拒绝；非设备所有者无法绑定；15 分钟 token 过期；撤销使旧 token 无效。
- [x] 写路径和互斥测试：前缀相似目录越界、junction 逃逸、路径别名指向同一锁；两个本地进程争同一根目录只能一个成功。
- [x] 写传输测试：重复 commandId 返回旧回执，换 payloadHash 拒绝；已 ACK 事件不补发，未 ACK 事件重启后补发；旧 connectionEpoch 不收新命令。
- [x] 运行 `node --test tests/runner-transport.test.mjs tests/agent-pairing.test.mjs` 验证失败。
- [x] 实现 Credential Manager 接入、单次配对、认证路由、15/45/60 秒时钟、递增 leaseEpoch、指数退避、本地排他锁；测试时注入时钟，不用真实等待一分钟。
- [x] 新增带 Bearer 的 /api/runner/connect 路由，置于现有浏览器 sameOrigin 分支前；校验 WS origin/认证与连接身份。
- [x] 测试通过并运行 `npm run check`、`npm run deploy:check`；记录迁移/绑定变更并提交。

验收：完整回归 545/545、类型与构建检查通过。轻单内完成配对、目录登记、清单关联、断开/重连、关闭网页后心跳及服务重启验证。真实解绑因自动审批拒绝而未执行，隔离测试覆盖撤销；详见 [第 3 步记录](../../agent-device-verification-2026-11-04.md)。

## Task 4: 异步执行 MCP

**Files:** 新增 worker/execution/mcp-server.ts、outbox.ts；扩展 auth.ts、runner-hub.ts；tests/execution-mcp.test.mjs。修改 worker/index.ts 与 wrangler.jsonc 的 `/executor-mcp` 路由。

**Interfaces:** ExecutionPort.createRun(input: CreateRunInput): Promise<RunReceipt>、getRun(runId, afterSeq?): Promise<RunView>、continueRun(input): Promise<CommandReceipt>、cancelRun(input): Promise<CommandReceipt>、listProjects(runnerId,cursor?): Promise<ProjectPage>；MCP 名称按设计第 8 节，不暴露任意本机命令。

- [x] 写真实 MCP transport 测试：未授权 401；错误 audience/owner/binding/authEpoch 拒绝；已持久化 intent 的 create_run 才可调用；离线 submit 返回 queued。
- [x] 写幂等测试：同 requestId 重放不重复投递；相同 ID 不同内容返回 IDEMPOTENCY_KEY_REUSED；submit 仅返回回执，不等待 fake Codex 完成。
- [x] 运行 `node --test tests/execution-mcp.test.mjs` 验证失败。
- [x] 用现有版本 createMcpHandler 和 Zod 注册五个执行工具；由 MCPClientManager 集成测试客户端调用，不能只测试 handler 的内部函数。
- [x] 工具先保存 outbox 再投递，返回 runId；输出事件与状态由现有 Hub 内的 ExecutionDispatch 持久化并查询，调用超时不删除意图；第 8 步再接入 ProjectQueue。
- [x] 测试通过，回归 `tests/mcp-oauth.test.mjs`，证明现有 `/mcp` scopes 不获得执行权限；提交。

详细实现采用 [第 4 步执行计划](2026-11-04-execution-mcp.md)，补充原计划中必需的原生持久化消费者和轻单体验入口。验收：完整回归 583/583、Worker/Runner 类型检查及部署 dry run 通过；真实 UI 验证创建文件、同会话补充、独立新会话、确认停止、只读总结、服务重启与页面恢复。审查问题均修复并复查通过，详见 [第 4 步记录](../../agent-execution-verification-2026-11-04.md)。

## Task 5: 原子清单生成、规格与排序写回

**Files:** 新增 worker/agent/canvas-store.ts、canvas-service.ts；tests/agent-canvas.test.mjs；修改 worker/room.ts，必要时提取 worker/canvas-commands.ts 的已有规划函数；复用 shared/agent/sort-plan.ts。

**Interfaces:** createAgentPlan(actor, input: CreatePlanInput): Promise<PlanReceipt>；reorderAgentPlan(actor, input: ReorderPlanInput): Promise<PlanReceipt>；readPlan(actor, planId): Promise<PlanSnapshot>；finalizeTaskRun(actor, input: FinalizeTaskInput): Promise<FinalizeReceipt>。所有输入含 requestId 和需要的 expectedRevision，actor 从服务端鉴权构造。

- [ ] 写 workerd 集成测试：生成 3 项后同事务包含块、规格、顺序、版本、outbox、回执；模型临时依赖 ID 正确映射为服务端 ID；3 项都是 done=false。
- [ ] 写排序/冲突测试：非计划任务相对位置保留，锁定项拒绝，51 项生成拒绝，跨 201 个便签排序拒绝；依赖环不产生部分写入。
- [ ] 写最终完成测试：另一块改动时可重读后完成本任务；当前 task specHash 改变时拒绝；重复 finalize 只产生一次业务效果，作者保留。
- [ ] 覆盖网页普通编辑、旧公共 MCP、撤销/恢复三个入口：正文从 CSV 改 PDF 后 sourceTextHash 不符、specStatus=stale，旧 instruction 不能被派发；重新生成完整规格匹配正文后恢复 ready。
- [ ] 覆盖原生 DDL 排序：无计划时维持原行为；多计划合法顺序同时更新各 planRevision；违反依赖整次拒绝且数据不部分写入。
- [ ] 运行 `node --test tests/agent-canvas.test.mjs` 验证失败。
- [ ] 新增 DO 内 schema migration：agent_plans、agent_task_specs、agent_receipts、agent_outbox；与 commitChanges 共用事务并使用现有广播；不改旧 MCP receipts 含义。
- [ ] 实现四个接口、计划版本、sourceTextHash、specHash、specStatus、依赖校验和完成回执；commitChanges 中统一处理语义变更失效和排序依赖检查。当前公共 MCP 九工具无需为内置 Router 先行扩展。
- [ ] 运行本任务测试和 `node --test tests/mcp-domain.test.mjs tests/mcp-storage.test.mjs tests/arranged-order.test.mjs`，确认通过后提交。

## Task 6: Router 聊天、记忆与上下文

**Files:** 新增 worker/agent/router.ts、model.ts、memory.ts、context.ts、chat-store.ts、route.ts；tests/agent-memory.test.mjs、tests/agent-chat.test.mjs。修改 Env、DO exports、Wrangler 新增 RouterAgent SQLite binding。

**Interfaces:** ModelPort.respond(input: ModelInput): AsyncIterable<ModelEvent>；ChatStore.append(message): MessageReceipt；MemoryStore.upsert(record, expectedRevision): MemoryRecord；forgetMemory(id, expectedRevision): ForgetResult；retrieveMemory(query: MemoryQuery): MemoryRecord[]；buildChatContext(input: ChatContextInput): ChatContext；buildExecutionSnapshot(input: SnapshotInput): ExecutionSnapshot。

- [ ] 写行为测试：普通“我想讨论登录体验”仅产生回答；“把刚才整理成清单”只调用 createAgentPlan；“开始执行”才产生 start_queue 意图。权限由服务端动作记录判断，不能仅相信模型输出 start=true。
- [ ] 写记忆测试：项目 A 记忆不进入 B；明确更正使旧版本失效；删除后 tombstone 阻止旧消息、阶段摘要、ProjectQueue 项目摘要及任务增量重新注入；未完成重建的段落立即不可用；只有明确新输入可解除被删除 key 的抑制。
- [ ] 写 memoryEpoch 测试：快照生成后发生遗忘，派发校验失败并重建；缺少必需约束时暂停；已经发送过相关记忆的旧会话不再自动续轮，不能声称已从本地历史撤回。
- [ ] 写边界测试：跨账号请求拒绝；messageId 重放不重复工具副作用；12 条/1,000 字符/48,000 字符上限；第 7 个工具调用不执行；关键约束超预算不能被静默删除。
- [ ] 运行 `node --test tests/agent-memory.test.mjs tests/agent-chat.test.mjs` 验证失败。
- [ ] 采用 Lifecycle 与 WebSockets，保存完整消息和阶段摘要；实现按 owner/project/key/type 的索引检索、sourceRefs、memory_tombstones、memoryEpoch、跨存储失效传播、版本冲突与保留期。
- [ ] 实现默认 Responses ModelPort、工具白名单和 Zod 校验；单元测试使用假模型，不消耗额度。API 开发执行时按 OpenAI Docs 工作流处理实际 API 凭据。
- [ ] 生成执行上下文时固定 summaryRevision、memoryEpoch、来源记忆 IDs、前序事实、任务规格和哈希；派发和自动续轮前重查当前 epoch。输入资料作为数据，不能新增权限。串流 delta 可丢失，最终消息必须落盘再确认。
- [ ] 测试通过、类型检查通过后提交。保留模型错误和中断的可恢复聊天状态。

## Task 7: 项目绑定与新会话总结

**Files:** 新增 worker/execution/project-queue.ts；扩展 bindings.ts、worker/agent/route.ts；tests/agent-project-init.test.mjs。

**Interfaces:** ProjectQueue.initializeProject(input: InitProjectInput): Promise<InitReceipt>；getProjectContext(): Promise<ProjectContext>；refreshSummary(input: RefreshSummaryInput): Promise<RunReceipt>；handleRunnerEvent(event: RunnerEvent): Promise<EventReceipt>。ProjectContext 包含 ready 状态、summaryRevision、capturedAt、sourceRunId 和 stale 标记。

- [ ] 写测试：选定 workspaceId 后创建 kind=summary 的新运行；重复 initialize 相同 requestId 复用原运行；成功前项目聊天不标记 ready；刷新/返回同一 chatId 不重开总结，显式新建聊天或刷新进度才创建新 summary。
- [ ] 写测试：summary 使用新 threadId 和只读策略；Codex 旧会话只作元数据来源；任务运行占用目录时总结等待；失败保留旧摘要但不默认冒充最新。
- [ ] 运行 `node --test tests/agent-project-init.test.mjs` 验证失败。
- [ ] 实现 DO 持久化初始化状态、summary revision、Scheduler 超时、MCPClientManager 的 ExecutionPort 适配和摘要结构验证。
- [ ] 项目列表聚合授权会话 cwd 与注册目录，保存 bindingRevision；目录/设备变更要求原活动批次先暂停、activeRun 终止且对账完成后才生效。
- [ ] 使用 Task 4 的 MCP 端点和 fake Runner 做跨组件验证：初始化 -> 回传结果 -> Router 可读项目上下文；测试通过后提交。

## Task 8: 串行状态机、验收与自动推进

**Files:** 新增 worker/execution/queue-reducer.ts、verification.ts、artifacts.ts、runner/verification.ts；扩展 project-queue.ts、outbox.ts；tests/agent-queue.test.mjs、tests/agent-finalization.test.mjs。

**Interfaces:** reduceQueue(state: QueueState, event: QueueEvent): QueueTransition（nextState + effects）；ProjectQueue.startBatch(input: StartBatchInput): Promise<BatchReceipt>；adoptPlanRevision(input): Promise<BatchReceipt>；pauseBatch(input)、resumeBatch(input)、cancelBatch(input)；evaluateAcceptance(run: RunView, evidence: Evidence[]): AcceptanceDecision。纯 reducer 不调用网络或模型。

- [ ] 写状态机测试：A -> B -> C；每次只出现一个 activeRun；每个新任务 createRun 产生新的运行标识；完成总结运行不影响任务完成。
- [ ] 写验收测试：turn.status=completed 但 outcome=needs_input 时暂停；缺少 required 证据不完成；human 条件待人工。仅命令非零或产物谓词不符且权限/基线/规格仍有效时允许 repairCount 从 0 到 1，在同一会话修复后重跑全部检查；重复失败事件不能再增加修复次数。
- [ ] 明确验证 blocked、needs_input、认证失效、超时、网络异常和未知启动状态都不触发自动修复；修复预算耗尽则暂停。
- [ ] 写 finalizing 测试：CanvasRoom 第一次返回临时失败，重试后成功；期间不启动下一项且不重复 Codex；receipt 成功后恰好生成一个下一项 outbox。
- [ ] 写版本与权限测试：pending 所有者改序后采用明确新版本，协作者改规格暂停，新增条目不自动进入已授权集合；旧 epoch 和旧 turn 结果不推进；页面选中项目变化不影响绑定。
- [ ] 运行 `node --test tests/agent-queue.test.mjs tests/agent-finalization.test.mjs` 验证失败。
- [ ] 实现队列事务、inbox/outbox、一次活动批次、依赖就绪选择、不可变快照、权限复检和 CanvasRoom completion receipt；下一项必须读取最新已采用计划。
- [ ] Runner 执行注册 checkId，记录 stdout/stderr 摘要、exitCode、时间和输出哈希，artifact 校验限制在工作目录；R2 上传走带 owner/run 范围的服务端接口。
- [ ] 实现暂停当前项后、立即中断、待审批、待输入、同会话恢复、结构化结果一次补全和重试预算；最终事实增量通过 runId 去重进入项目记忆。
- [ ] 跑两组测试加 `npm run check`，通过后提交。

关键验收断言使用持久化效果而不是模型文本：

```js
assert.equal(state.status, 'finalizing');
assert.equal(outbox.filter(x => x.type === 'create_run_for_next_task').length, 0);
// finalize receipt 到达后，同一 completed 再投递一次，下一项 outbox 仍只有一条。
```

## Task 9: Agent、项目与清单 UI

**状态：已完成本机正式界面整合。** 按用户后续确认，复用前八步已有能力，具体实现采用 [正式工作区计划](2026-11-05-agent-workspace.md)，不另建一套聊天或队列后端。

**Files:** 新增 `AgentWorkspace.jsx`、`WorkspaceDrawer.jsx`、`workspace-state.js`、`agent.css`；在 ChatPanel、ChecklistPanel、BatchPanel、DevicePanel、MemoryPanel 增加嵌入方式，复用 PermissionControls。CanvasWorkspace 增加正式 Agent 视图。新增工作区、联动与弹窗测试，扩展已有面板测试。

- [x] 顶部视图、项目选择、桌面并排聊天与待办/执行、窄屏导航；画布与排列原有状态保留。
- [x] 项目摘要与记忆抽屉、来源与验收记录、真实目录和权限设置；打开界面不自行派发任务。
- [x] 提案保存后刷新真实清单；排序沿用上移/下移及业务 API，执行回写后自动刷新，保留未提交草稿。
- [x] 同批次同会话，下一次提交新会话；准确批次跳转、历史切换、暂停继续和原生审批/提问。
- [x] 账号/项目/聊天草稿隔离、后台请求提醒、跨项目重试去重、上层弹窗键盘优先权。
- [x] 实际 DeepSeek 三项提案保存与排序、记忆增改删、390px 窄屏和刷新恢复；读取第八步真实完成批次显示三项验收及清单更新。
- [x] 最终 821 项测试、类型检查、Runner 类型检查、构建预检通过，保存截图与[验收记录](../../agent-workspace-verification-2026-11-05.md)。按本轮范围未提交、未部署。

当前聊天显示真实异步回复与等待状态，不模拟逐字流式；本轮没有新增依赖计划或拖动排序。上述原规划中的独立任务会话已被用户确认的批次模式替代。

## Task 10: 故障注入、安装与发布验收

**状态：本机实现、三待办真机验收与最终回归完成。** 采用 [第十步实施范围](2026-11-05-agent-install-recovery.md)，记录见 [安装与恢复验收](../../agent-install-recovery-verification-2026-11-05.md)。沿用用户后来确认的同批次同会话，不采用旧草案每项新建会话。

- [x] checkout 内安装/隐藏启动/停止/重启/诊断/卸载入口，认证实例身份、重复启动复用、应用就绪检查；卸载保留数据与凭据。
- [x] SQLite 生命周期互斥、Windows 路径和 PowerShell 中文编码、损坏控制密钥拒绝；隔离安装测试与独立审查。
- [x] 派单、原生接收、事件、报告、推进许可、清单写回的丢 ACK 和崩溃恢复；未知执行保持阻断，不按超时重发。
- [x] 重连立即续有效租约；过期的已验收暂停点显式核对原生历史、回写、目录与 Git 后恢复原租约；恢复回执幂等；停止意图跨崩溃保留。
- [x] 正式界面诊断与原批次跳转；异常暂停点显示核对并恢复连接，恢复后再明确继续。
- [x] 三个现有待办实测执行器断网、暂停点进程崩溃、原批次恢复、完成后的普通服务重启、旧创建请求重放；同 run/thread、三任务轮次、三次确认回写、报告哈希不变。
- [x] 类型检查、构建与本地部署 dry-run；发布和回滚步骤写入部署指南。
- [x] 最终冻结版本完整回归 882/882 通过，结果补入验收记录。

范围决定：安装在当前 checkout 的 `.tmp/agent-install`，不注册全局服务/登录计划任务，不生成独立发行包；不自动删除凭据、任务记录或按30/90天清理恢复证据。本次未重启整台电脑、未提交 Git、未发布生产；这些不能据本机验收标成已完成。正常 stop/restart 保守拒绝活动/未知任务（包括暂停批次），`--interrupt-active` 是中断语义，不是续跑命令。

## 需求到任务的覆盖

| 用户需求 | 实施任务 |
| --- | --- |
| 先列 Codex 会话并选择项目 | 2、3、7、9 |
| 新建总结会话后再聊天 | 2、4、7、9 |
| 正常聊天和可管理记忆 | 6、9 |
| 直接生成未完成清单和排序 | 1、5、6、9 |
| MCP 派发，本机新建会话执行 | 2、3、4、8 |
| 同批次共用一个会话，下一批次新建会话 | 2、8、10 |
| 完成后自动执行下一项 | 5、8、10 |
| 失败暂停、重启恢复、防重复 | 2、3、4、8、10 |

## 方案交付自检

- [x] 项目绑定与历史会话区别明确，同批次沿用同一线程，下一批次新建线程。
- [x] Codex 执行成功、验收通过、画布写回和下一项派发有独立阶段。
- [x] 定义了现有代码的连接点，排序与规格不会被旧 schema 静默丢弃。
- [x] 聊天记忆有来源、版本、检索范围和遗忘机制。
- [x] MCP 是真实异步工具契约，Runner 事件与 MCP 请求回执分开。
- [x] 真实 API 状态与模拟测试区分，三个真实待办的执行、验收、回写与恢复均有原始记录。

实现者可以决定模块内部的小型辅助函数、UI 细节和日志后端。产品流程、默认阈值、权限边界、状态权威和接口名称按设计与本计划执行；改变这些内容先更新设计。当前已完成上述限定范围的本机实现与真实 Codex 验收，未提交 Git、未部署生产。
