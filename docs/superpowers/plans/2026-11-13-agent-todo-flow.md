# Agent 待办输入与归档 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan in the current session. Preserve the existing uncommitted work.

**Goal:** 同一轮完成用户指定的六项：底部简洁输入、完成项自动移出主列表、默认折叠的完成收集区、全选、准确计数。

**Architecture:** 沿用 React、画布待办与版本化执行接口。输入区放在未完成列表之后，保存提示和正常在途请求不再占据列表上方；新增只展示正文。完成收集区区分真实 `done` 与“执行已结束，待核对”，不以执行终止状态推断验收通过。空白编辑行不展示、不计数、不参与全选。

**Tech Stack:** React 19、Node 24、node:test / jsdom、现有 Cloudflare Worker。

**Spec:** 用户本轮六项待办及 `AGENTS.md`。

## Constraints and choices

- 仅修改 `qingdan-canvas`。当前 `feat/qingdan-mcp` 有大量已有修改，在原工作区增量修改，不重置、不提交混合改动、不部署。
- 现有对象版本、回执、恢复、同步 `source` 和验收协议保持有效。
- 采用底部输入；顶部输入会挤动列表，弹窗输入不利于连续记录，均不采用。参考 Microsoft To Do 官方的底部追加与回车保存。
- 全选只选择当前可派单待办。超过现有 50 项上限，选取清单顺序的前 50 项并明确说明。完成区默认关闭，用户可展开查看和删除。
- 第 2 项解释为删除新增区的“执行要求与验收”折叠表单；已有待办的详细编辑能力和已保存条件保持兼容。

## Review focus

- 空白行、纯空格、正文便签不会变成可派单任务，重排忽略空白编辑行但不删除原始对象。
- 选中项完成、锁定、版本变化后不会随全选误派；全选和取消不会发起执行。
- 输入法 Enter、Shift+Enter、重复保存、失败草稿与账号/项目隔离保持有效。
- 整组执行正常结束且本机确认停止后，同版本来源自动收起并标待核对；只有 `done` 才标已完成，不写回验收状态。取消、原生运行失败、新尝试或版本变化不会被旧结果收起。
- 长列表连续添加不推动已有行；完成区展开状态与各项目隔离。

## Tasks

- [x] 1. 在 `tests/agent-checklist-ui.test.mjs`、`tests/agent-workspace-shell.test.mjs`、`tests/agent-checklist.test.mjs` 补充空白计数、完成分组、全选与上限行为回归，先验证失败。
- [x] 2. 修改 `ChecklistPanel.jsx` / `TaskComposer.jsx` / `agent.css`，实现底部输入、无表单附项、稳定提示、完成折叠与全选。统一工作区计数和实际待办过滤；后端重排忽略空白占位行。
- [x] 3. 跑定向测试，再运行 `npm test`、`npm run check`、`npm run deploy:check`。浏览器检查短/长列表和窄屏；使用隔离测试页面，不占用用户设备绑定。
- [x] 4. 更新 `docs/agent-experience.md`，进行最终代码检查并记录验证事实，提交轻单回执。

## Evidence / progress

- 基线：2026-11-13，三个相关测试文件 80/80 通过（`.tmp/agent-todos-baseline.log`）。

- 定向回归：90/90 通过（`.tmp/agent-todos-green.log`）。新增回归均先观察到预期失败后修复。
- 独立审查发现并修复：运行历史窗口滚动导致回弹、跨客户端新运行未被轮询发现、200 项截断计数、解绑计数未重置。覆盖测试包含历史移出后重挂载、刷新令牌带入新尝试、201 项计数、未绑定计数回调。
- 决策：正常结束的整组任务按同版本来源收起并标待核对；不会写入验收通过。该可逆显示状态按浏览器/账号/绑定保存，跨浏览器只能从近期服务端历史重建。
- 浏览器：隔离 Edge 无头页面，1440px 桌面连续保存时首行位置保持不变；30 项长列表、390px 触屏添加/收起/移回及无横向溢出通过。原 CUA 与 node_repl 初始化报 kernel assets 路径错误，因此使用项目内 Playwright 测试脚本和独立浏览器上下文。
- 首次全量：1370/1371 通过；`agent-lifecycle-control.test.mjs` 的 `source recovery uses authenticated local control without an installed manifest or backend session` 出现临时文件重命名 EPERM，单独复验 3/3 通过。最终全量 1372/1372 通过（`.tmp/agent-todos-full-tests-final.log`），退出码 0。

- 最终类型检查、构建/发布预检、桌面与触屏检查通过；记录见 `docs/agent-todo-flow-verification-2026-11-13.md`。独立审查问题以新增回归 RED→GREEN 修复，最终全量通过。未提交、未部署、未另发起真实 Codex 任务。
