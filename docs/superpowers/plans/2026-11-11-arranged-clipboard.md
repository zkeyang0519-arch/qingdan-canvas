# Arranged Clipboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 排列模式支持外部文字整段粘贴成一个待办，以及右键复制待办文字到外部。

**Architecture:** 复用现有任务模型和保存流程，为排列模式启用单条粘贴规则。使用一个专用剪贴板 hook 管理非编辑区菜单、异步权限及目标校验，编辑区继续使用浏览器原生菜单。

**Tech Stack:** React、系统 Clipboard API、Node test runner、jsdom；不新增依赖。

**Spec:** `docs/superpowers/specs/2026-11-11-arranged-clipboard-design.md`

## Global Constraints

- 在 `feat/qingdan-mcp` 分支实现，保留原有 18 个未提交输出文件。
- 一次粘贴只生成一个待办，多行文字保留在同一条中。
- 不改变画布模式或常用清单模板原有的按行导入行为。
- 不新增依赖、数据库字段或服务端接口。
- 浏览器验收使用隔离测试数据。

## Review Focus

- 复制到的文本含 CRLF、空行及列表前缀时，保留正文且只新增一条。
- 编辑中替换选区时保留前后文字、待办 ID、备注、完成状态和日期。
- 剪贴板读取期间切换账号、项目或画布，甚至切回原目标，也不能插入旧操作。
- 只读、锁定以及读取过程中权限变化时，可以复制但不能写入。
- 剪贴板权限拒绝后提供真实可用的快捷键或手动复制入口，不误报成功。

### Task 1: Single-task paste in every arranged text entry

**Files:** `src/canvas/ArrangedWorkspace.jsx`, `src/canvas/Note.jsx`, `tests/arranged-order-ui.test.mjs`.

**Interfaces:** `EditableBlock` 新增 `singleTaskPaste=false`；排列模式传 `true`。保留 `pasteText(text, html, pageId)` 的现有调用接口。

- [x] 新增真实组件用例：粘贴 `"一行\r\n\r\n- 第二行"` 后只增加一个 block，内容为 `"一行\n\n- 第二行"`；空白文本不新增；草稿保存仍为一个 block；编辑选区替换后 ID、备注、日期和完成状态不变。
- [x] 运行 `node --test --test-name-pattern="剪贴板" tests/arranged-order-ui.test.mjs`，确认新用例因旧版按行拆分而失败。
- [x] 排列模式新建及草稿直接创建单个 `makeBlock`；编辑器通过显式选项保留多行纯文字插入，复用原有 onChange 保存。
- [x] 运行 `node --test tests/arranged-order-ui.test.mjs tests/arranged.test.mjs`，期望全部通过，包括原有行拆分模型用例。

### Task 2: Clipboard menus, scope guards, and verification

**Files:** 新增 `src/canvas/useArrangedClipboard.jsx`；修改 `src/CanvasWorkspace.jsx`、`src/canvas/ArrangedWorkspace.jsx`、`tests/arranged-order-ui.test.mjs`。

**Interfaces:** `useArrangedClipboard({workspace, boardId, libraryKey, selected, blocked, beforeAction, onToast, pasteText})` 返回 `{onContextMenu, onCopy, overlay, close, isOpen}`；`pasteText` 使用 Task 1 的单条插入行为。`ArrangedWorkspace` 增加 `clipboardBlocked`，区分弹窗阻挡与只读状态，使只读待办仍能复制。

- [x] 增加组件用例验证整条正文复制、只读及锁定复制、删除入口保留、编辑区原生菜单不取消、空白处右键粘贴为一个待办。
- [x] 增加失败与竞态用例：读/写权限拒绝，选区替换，异步读取期间切换账号或项目、切走再切回及锁定目标。
- [x] 运行相关新用例，期望缺少菜单/原生菜单被拦截等明确失败。
- [x] 实现专用 hook：调用浏览器 Clipboard API；用当前任务数据复制完整正文；用可选中的只读文本框处理复制失败；用作用域代次及最新权限检查取消失效读取。
- [x] 接入排列模式根节点的 contextmenu/copy；移除行级旧菜单拦截；编辑区保留原生菜单；原有删除通过 TodoTools 执行。
- [x] 运行相关组件测试及共享编辑器测试：最终 65 项全部通过，包含审查发现的只读菜单和点击后键盘焦点回归用例。
- [ ] 使用隔离浏览器验证真实文本选区、菜单和剪贴板交互。**未完成：Computer Use 无法可靠确认当前浏览器 URL，工具停止了本轮浏览器操作。**
- [x] 运行 `npm test -- --test-concurrency=4`、`npm run check`、`npm run runner:check`、`npm run deploy:check`，最终退出码均为 0，全量复跑 1200/1200 通过。首次全量有一项原有 Agent 启动用例超时，该组单独复测及后续全量复跑均通过；本次未修改 Agent 启动代码。
- [x] 对本次完整差异做一次独立审查，必要修复先复现后验证；核对原有输出文件哈希。交付功能及验证结果，提交和推送沿用用户后续指令。
