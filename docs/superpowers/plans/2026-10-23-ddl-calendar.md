# DDL 月历 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 在排列视图接入真实 DDL 月历，默认只展示当前灵感板，同一天超过三项可展开全部。

**Architecture:** FullCalendar React 月视图读取 `panePages(...).page.tasks`，不复制任务或增加服务端模型。日期编辑复用 `TaskDeadlinePopover` 和 `setPageDeadline`，完成状态复用现有 workspace 操作。视图选择仅保存到本机 preferences。

**Tech Stack:** React 19、FullCalendar React 7.1.3、temporal-polyfill 1.0.1、现有 DayPicker、Node test + jsdom。

**Spec:** 用户已确认的 HTML 效果方案：`C:/Users/26437/.codex/visualizations/2026/10/23/01a1673c-1a28-7751-a502-c25f6fbecff9/qingdan-ddl-calendar/plan.html`。2026-10-23 用户确认「当前灵感板」并授权「接入正式界面」。

## Global Constraints

- 在 `D:/TODO/qingdan-canvas` 增量修改，保留已有头像等未提交工作。
- 周一开始、中文、本地日期；UTC `dueAt` 存储不变。
- 每日最多显示 3 项，另显示「还有 N 项」；相同时间的任务独立保留。
- 默认隐藏已完成，可显示已完成；无 DDL 的任务留在清单。
- 完成、改期、来源定位复用现有数据与同步通道，保留权限、锁定、协作冲突检查。
- 本次不添加拖动改期，不部署，不提交其他工作的改动。

## Review Focus

1. UTC 接近午夜与不同时区：使用本地日期分组，不把截止时间画成跨日持续事件。
2. 同日同时间/同名任务：保留独立身份、稳定顺序和完整溢出列表。
3. 正在编辑时被锁定、收纳、删除或改期：拒绝过期写入，给出可理解提示。
4. 切换灵感板、清单/月历及来源定位：范围与焦点正确，草稿先保存，隐藏清单不保留危险选择。
5. 窄屏、无日期任务、已完成过滤：空状态清楚，月历和展开清单可操作。

---

### Task 1: 月历数据和本机视图偏好

**Files:** Create `src/canvas/deadline-calendar.js`, `tests/deadline-calendar.test.mjs`; modify `src/canvas/arranged-model.js`.

**Interfaces:** `deadlineEvents(page, {showCompleted, now})` 返回 FullCalendar events；`localDayKey(value)` 返回本地 YYYY-MM-DD；`setArrangedView(state, boardId, view)` 仅更新本机清单/月历选择。

- [x] 先写并运行数据测试：默认范围、缺失/非法日期、完成过滤、同时间独立 ID、午夜分组、偏好不进入共享写入。
- [x] 实现上述函数，保留切换灵感板和排列模式时的 view。
- [x] 运行 `node --test tests/deadline-calendar.test.mjs tests/arranged.test.mjs`，全部通过。

### Task 2: 正式 UI 与已有操作接线

**Files:** Create `src/canvas/DeadlineCalendar.jsx`, `src/canvas/deadlineCalendar.css`, `tests/deadline-calendar-ui.test.mjs`; modify `src/canvas/ArrangedWorkspace.jsx`, `package.json`, `package-lock.json`.

**Interfaces:** `DeadlineCalendar` 接收当前 page、clock、disabled、deadlineEditor、onDeadline/onDeadlineClose/onDeadlineSave/onToggle/onLocate。父级共享保存入口，所有写入查最新任务。

- [x] 先写并运行交互测试：进入月历、3+N、展开所有同日任务、完成后清单联动、切换范围、改期与冲突、只读与锁定。
- [x] 实现中文月历、翻月/今天、已完成筛选、日期/任务打开当天面板、现有日期选择器和定位入口。
- [x] 接入工具栏切换；使用惰性加载；保留现有草稿导航和同步行为。
- [x] 运行新增交互测试和已有截止日期测试，全部通过。

### Task 3: 验证与交付

**Files:** 更新方案确认项与此文件进度；测试证据放在 `.tmp/ddl-calendar/`。

- [x] 运行 `npm test`、`npm run check`、`npm run deploy:check`，只做 dry run。
- [x] 用真实组件的隔离数据页面验证桌面和窄屏、同日六项展开、改期、完成与来源定位；保存截图。
- [x] 独立审查本次差异，修复重要问题，并再次运行受影响检查。
- [x] 向用户提供入口、验证结果及尚存限制，不部署。

## Execution ledger

- 2026-10-23：用户已授权接入；原 checkout 为 develop，包含关联的未提交头像工作。保留当前 checkout，避免遗漏现有依赖或提交其他工作；实施步骤作为本次记录。
- FullCalendar v7 已将 daygrid 合并进 React 包，按官方 v7 文档安装两个精确版本，不混用 v6 插件。
- Task 1 complete：3 项月历数据测试通过，16 项已有排列模型测试通过。
- Task 2 complete：7 项月历交互测试通过；现有日期选择器交互回归通过。
- 独立审查发现的 3 项问题已修复：清理已卸载清单的 API 并阻止月历编辑旧选择；取出无日期任务先回清单再定位；当天面板使用 sticky 定位避免滚动裁掉标题。前两项回归测试均观察到失败后修复通过，第三项经浏览器复现及修复确认。
- Task 3 complete：完整 `npm test` 192/192；`npm run check`、`npm run deploy:check`、格式检查和 diff 空白检查通过。初次并行运行构建与测试导致测试 Worker 随 assets 更新重启，构建后独立重跑全套已通过。
- 浏览器验证：桌面 3+3 展开、完成 6→5、改期转移至 29 日、灵感板切换；390px 窄屏工具栏、展开、滚动到最后一项并完成。浏览器未记录 error/warn。
- 最后的窄屏 CSS 调整经过浏览器核对及重新构建预检。没有部署或提交；保留工作区现有头像等改动。
- 验证日志：`.tmp/ddl-calendar/tests-final.log`、`deploy-final.log`。独立示例页面为 `.tmp/ddl-calendar/fixture.html`，不写入真实任务。
