# Agent 节点恢复修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal** 修复已审计的节点恢复问题，先完成两个 P1，再逐节点验证并交付。

**Architecture** 沿用现有服务边界、状态机与持久化模型。恢复操作必须可重复核对，安全停止必须绑定真实运行与后台命令。各节点由原审计 Agent 负责，根 Agent 负责接口协调与独立审查。

**Tech Stack** React、Node 24、TypeScript、Cloudflare Workers、SQLite Durable Objects、Codex app-server。

**Spec** docs/superpowers/specs/2026-11-11-agent-node-recovery-design.md

## Global Constraints

- 实现目录以本计划所在工作树为准，不修改 D:/TODO/qingdan-canvas 的用户代码，集成由根 Agent 最后执行。
- 不读取 .dev.vars 或真实凭据，不占用用户绑定、活动服务或项目目录。测试使用隔离状态与随机端口。
- 保留账号、目录、绑定版本、租约、回执及对象版本校验，支持变更前的持久化数据。
- 产品修改采用实际回归的红绿验证。每节点检查独立运行、断线重连、重启和手动恢复。
- 不部署、不推送、不运行真实付费模型任务。提交仅发生在隔离工作树。
- 先通过 N7 两项 P1 修复与独立评审，再修改其他节点产品代码。
- 由根 Agent 派发评审，子 Agent 不自行派生其他 Agent。

## Review Focus

- 持久意图已保存而 RPC 未发出的崩溃窗口，恢复能发送并确认停止。
- 原始回执丢失且客户端或服务端重启，恢复使用同一请求身份。
- 旧连接、旧账号或旧项目的迟到结果不能污染当前状态。
- 旧数据缺少新恢复字段时保持保守校验并具有可解释出口。
- 依赖节点不可用时，独立可用的数据与手动恢复入口继续显示。

### Task 1: N7 两项 P1

**Files** runner/codex-adapter.ts、runner/executor.ts、runner/execution-store.ts、runner/batch.ts 及对应 runner/recovery 测试。

**Interfaces** 复用现有 cancelRun、reconcileRun、stopIntent、interruptOnce 和终态上报，保持调用方兼容。先解决所有释放路径的后台终端确认，以及停止意图与送达确认的区别。

- [ ] 将 N7 审计复现转成产品回归，确认旧实现失败。
- [ ] 失败、正常结束、取消和重启恢复均经过必要的后台终端核对，核对失败时保留占用。
- [ ] 已持久化但未送达的安全停止可恢复，目标轮次与连接代际保持准确，老 interruptOnce 数据可恢复。
- [ ] 运行 targeted runner/recovery、类型检查，记录四类恢复矩阵。
- [ ] 自查并只提交本任务文件，根 Agent 独立评审。

### Task 2: N5 派单持久性

**Files** worker/execution/batch-queue.ts、dispatch.ts、outbox.ts、hub.ts、execution-router.ts、shared/agent/execution.ts 及派单队列回归。

**Interfaces** 现有 queue control 和 batch-gate 重试必须返回同一回执/许可。过期交付的恢复协议先由 N5 提供设计，根 Agent 与 N7 核对，执行侧随后接入。

- [ ] 将真实 DO 的回执和许可中断窗口变成失败回归。
- [ ] 原子提交队列状态与控制回执，原子提交修复计数与许可。
- [ ] 为过期或未知首次交付提供安全的核对/取消路径，持久化结果并保护有效租约。
- [ ] 验证 DO 重启、重连、重复恢复和取消的组合，提交评审。

### Task 3: N7 会话身份与过期运行恢复

**Files** runner/codex-adapter.ts、executor.ts、store.ts、execution-store.ts 及 runner/recovery 测试。

**Interfaces** 消费 Task 2 的恢复协议。明确区分尚未发送任何 turn 与已发送但响应未知，保存可证明的核对事实。

- [ ] 复现丢失 thread/start 响应和过期首轮交付的恢复失败。
- [ ] 实现有持久证据支撑的找回或终结，支持老数据，不猜测关联其他会话。
- [ ] 与真实派单组件联跑重启/重连/人工核对/取消，确认无重复轮次和无提前释放。
- [ ] 提交评审并记录剩余真实 Codex 验证边界。

### Task 4: N6 设备连接与重配

**Files** runner/device-controller.ts、transport.ts、device-store.ts、scripts/lib/local-runner-api.mjs、src/agent/DevicePanel.jsx 及设备/路由测试。

**Interfaces** 现有配对、重连、忘记设备接口保持兼容。必要恢复动作经当前登录账号授权，必须核实无活动或未知执行。

- [ ] 迟到配对、pending 503、缺凭据重配均建立回归。
- [ ] 串行/代际防护覆盖所有身份切换，pending 支持退避与手动恢复。
- [ ] 提供缺凭据时的受控恢复出口并验证跨账号拒绝、活跃任务拒绝及响应丢失重试。
- [ ] 验证四类场景并提交评审。

### Task 5: N9 服务生命周期

**Files** scripts/lib/agent-install.mjs、agent-install-bridge.mjs、agent-experience-server.mjs、agent-experience-launcher.mjs、scripts/dev-agent.mjs 及安装/服务测试。

**Interfaces** 生命周期命令保留既有语义，迁移恢复必须检查旧实例身份，关闭应涵盖正在握手的 socket。

- [ ] 迁移 checkout 和挂起 WebSocket 关闭建立回归。
- [ ] 实现明确修复入口、完整连接清理和有限超时。
- [ ] 检查崩溃恢复和手动启动，改进可恢复的监督路径，禁止自动清除未知执行状态。
- [ ] 验证暂停/停止/重启的行为与 N6/N7 对接，提交评审。

### Task 6: N1 网页工作区恢复

**Files** src/agent/BatchPanel.jsx、workspace-state.js、AgentWorkspace.jsx、PendingBatchNotice.jsx 及 UI 测试。

**Interfaces** 在现有草稿存储逻辑上提供可复用的持久请求/草稿机制，明确账号/画布/项目/绑定/会话/运行作用域，向 N2/N3/N4 提供用法。

- [ ] 迟到轮询、刷新丢补充说明和旧错误提示建立回归。
- [ ] 避免响应倒退，保存不确定操作及准确 payload，恢复后先核对。
- [ ] 验证重挂载与新浏览器会话、跨账号/项目隔离及存储不可用提示。
- [ ] 提交评审并记录共享接口。

### Task 7: N2 聊天与记忆

**Files** src/agent/ChatPanel.jsx、MemoryPanel.jsx、worker/agent/chat-router.ts、chat-store.ts 及聊天测试。

**Interfaces** 使用 Task 6 的持久化方法；记忆读取与摘要状态错误分离，保留记忆删除和来源栅栏。

- [ ] 真实 HTTP ACK 丢失后整页重载与 Hub503 记忆读取建立回归。
- [ ] 持久保留发送请求，恢复核对原任务；提供独立可用的记忆入口。
- [ ] 验证模型失败/重启/手动重发与授权隔离，提交评审。

### Task 8: N3 项目总结

**Files** worker/execution/project-summary.ts、project-summary-route.ts、src/agent/ProjectSummaryPanel.jsx、shared/agent/project.ts 及总结测试。

**Interfaces** 持久操作意图与底层 run 关联，复用 Task 6 的请求保存；明确非终态待核对状态。

- [ ] 未停止总结被覆盖和 launch 后协调提交失败建立回归。
- [ ] 状态读取能恢复未完成操作，阻止重复总结，保留轮询和停止入口。
- [ ] 验证两个页面并发、旧摘要采用、目录变更及重启，提交评审。

### Task 9: N4 清单界面

**Files** src/agent/ChecklistPanel.jsx、必要的 worker/agent-checklist.ts 回执查询及清单测试。

**Interfaces** 各展示模式统一使用持久草稿/请求，冲突恢复保留服务端版本校验，未知操作须核对后再决定放弃。

- [ ] 验证页丢ACK、旧版本刷新、pending 上限建立回归。
- [ ] 修复不同展示模式的恢复差异，提供明确版本冲突和积压请求恢复。
- [ ] 验证普通清单独立性、真实 DO 重启、事务与重放，提交评审。

### Task 10: N10 独立连接器

**Files** codex-connector/public/app.js 及 connector UI/连接恢复测试。

**Interfaces** 项目查询绑定连接代际，轮询错误与业务错误分离。

- [ ] 旧项目响应和残留断线提示建立回归。
- [ ] 修复连接代际和成功恢复后的提示，保留有限自动重试与手动入口。
- [ ] 验证独立启动/自动重连/进程重启/手动恢复和退出，提交评审。

### Task 11: N8 验收写回及整链复核

**Files** 现有验收/写回测试，必要时增加独立真实 DO 恢复回归。避免无缺陷的产品重写。

**Interfaces** 消费所有修复后的执行终态、验收证明、队列许可及清单回执。

- [ ] 验证文件验收、人工验收、暂停/续跑、失败停止后重提。
- [ ] 验证 ACK 丢失、用户重新打开、Runner/DO 重启后的原回执补收。
- [ ] 逐节点填写四类恢复矩阵，明确实机边界。
- [ ] 执行全套检查，完成独立总审查，再将修复差异安全同步原工作区。
