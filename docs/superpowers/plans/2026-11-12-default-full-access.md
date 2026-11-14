# 后续任务默认完全访问 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline. 用户已明确授权后续轻单任务默认完全访问，无需重复确认。

**Goal:** 新提交执行任务默认完整文件访问和联网，Codex 不再逐次请求操作审批。

**Architecture:** 新增 full_access 权限档位，服务端将其固化为 network=true 的不可变快照；Runner 所有启动、续跑、恢复和批次后续轮次使用 danger-full-access / never。前端默认和账户/绑定偏好与之保持一致。旧任务快照不提权，摘要仍只读。

**Tech Stack:** React / TypeScript / Node.js 24 / 固定 Codex 0.167.0-alpha.3.2 协议 / Cloudflare Workers。

**Spec:** 用户“以后轻单的任务都默认给完全访问”。延续已批准的只读项目摘要，不自动撤回之前的拒绝或重启旧任务。

## Global Constraints

- 当前工作区既有修改保留，本轮基线 .tmp/full-access-baseline；不提交其他修改，不远端部署。
- 新任务缺省权限 full_access，允许明确选择只读、项目内人工批准或自动审查。
- 用户授权的新默认覆盖旧浏览器的默认/偏好；启用 v2 偏好键，升级后新任务默认 full_access，之后显式选择继续按账号与绑定隔离保存。
- full_access 对应 network=true、danger-full-access、never；其余档位 network=false 且 on-request；摘要始终 read_only。
- 已派发任务、旧批次、旧无权限快照保持原语义，不自动同意已拒请求、不自动重发任务。

## Review Focus

- 新 UI 与直接 API 缺省一致；快照不可被后续 create 请求变更。
- 新档位的网络值严格匹配，不能给受限档位夹带 network=true。
- thread/start、turn/start 和所有 thread/resume 分支都应用相同固化权限。
- 老批次恢复仍按旧权限；只读摘要不能借全访问默认提权。
- 旧偏好不会让当前项目仍默认为人工审批；用户之后的明确选择能持久化。

## Tasks

- [x] 1. 增加 full_access schema/缺省解析，更新 dispatch 与 Codex adapter 各调用分支；先扩展派单和 Runner 协议回归再实现。
- [x] 2. 权限界面默认完全访问与 v2 偏好，更新说明；UI 默认、显式选择、跨账号/绑定和旧偏好测试 RED→GREEN。
- [x] 3. 运行相关测试及全量回归、check/runner build/deploy dry-run，独立审查；本机无活跃执行后安全更新服务并确认界面默认。

## Execution Ledger

- Pre-flight: UI 只提交 profile；dispatch 决定 network 并固化权限，Runner 消费同一快照；旧无 profile 的 Runner 快照保留既有 workspace-write / on-request 语义。
- Ruling: 使用用户明确授权的完全访问，直接修改产品与本机配置流程，不借此更改当前对话工具权限或用户已拒绝的历史请求。
- RED: 原代码对 UI 默认、派单默认与 full_access Runner 快照的 3 个回归均失败（.tmp/full-access-red.log）。
- GREEN: 相关 5 个测试文件 180/180 通过；新增 schema 不一致网络/摘要提权拒绝及批次后续轮次、暂停点核对、停止核对、活动轮次重连 2/2 通过。check、runner:build、deploy:check 通过（仅 dry-run）。
- Review: .tmp/full-access-review.diff 为本轮 10 个文件相对基线差异；独立 reviewer 未发现 Critical/Important/Minor 问题。既有改动未纳入本轮审查；本机更新及全量验证由主流程完成，未额外派发真实任务。
- Final verification: 全量 1309/1309 通过，0 失败、0 跳过（.tmp/full-access-full-tests.log）；check、runner:build、deploy:check 与 git diff --check 通过。仅 dry-run，未远端部署。
- Local update: 确认 active.count=0 后 agent:restart 成功；新服务 pid=30360、instanceId=c9fbecaa-43be-4117-b212-4e40905413ff，ready/running、两端口正常。当前 Edge 刷新后执行设置显示「权限：完全访问」，仍为 surge（我）、电脑在线；没有更改、重发或恢复旧批次。
