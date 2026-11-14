# Dynamic Island Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans; focused test authoring and final review are delegated. Steps use checkbox syntax.

**Goal:** 交付可开关的网页灵动岛，操作轻单真实待办。首版在独立 feature 分支完成后，按用户最新要求接入原 Agent 分支 `feat/qingdan-mcp`。
**Architecture:** CanvasWorkspace 管开关与阻塞；DynamicIsland 复用现有任务模型和同步 workspace，单独 CSS 隔离样式。无新的数据副本。
**Tech Stack:** React 19、现有 lucide-react、Node test / JSDOM / esbuild。
**Spec:** `../specs/2026-11-13-dynamic-island-design.md`

## Global Constraints

- 首版基线 `ea47f8b`；后续将 `ca57dc4` 的灵动岛改动增量接入 `D:/TODO/qingdan-canvas`，保留原目录未提交修改。以下已完成记录对应首版验证，接入后的复验见 `docs/dynamic-island-verification.md`。
- 使用现有同步写入和本机视图偏好，保持 readOnly/锁定保护。
- 不添加依赖，不部署，不连接用户设备或改变实际账号状态。

## Review Focus

- 中文输入法 Enter 和多行文字：只在明确提交时创建一个待办。
- 当前项目被收纳/删除或锁定：旧草稿不能写入回退项目。
- 鼠标焦点与键盘焦点区别：离开可收起，编辑中和键盘操作保持展开。
- 全局快捷键和窗口较窄：不能删除背景选区或遮住必须操作入口。
- 新增被同步层拒绝：保留输入，不报告成功。

### Task 1: Real task capsule and integration

**Files:** Create `src/island/DynamicIsland.jsx`, `src/island/dynamic-island.css`, `src/island/preferences.js`; modify `src/CanvasWorkspace.jsx`; test `tests/dynamic-island-ui.test.mjs`, `tests/island-preferences.test.mjs`.
**Interfaces:** consumes workspace.state/current/update/toggleBlock/readOnly/status and existing panePages/writablePage/appendPageObjects/choosePanePage. Produces DynamicIsland({workspace,boardId,onDisable,beforeAction,top}) and setIslandPreferences(state,boardId,patch).

- [x] Write behavior tests for interactions, correct project writes, IME, lock/read-only, draft preservation; observe failure before implementation.
- [x] Implement component, bounded responsive layout, navigation toggle and account/room-scoped preferences.
- [x] Run `node --test tests/dynamic-island-ui.test.mjs tests/island-preferences.test.mjs` → 12 pass.
- [x] Browser check collapsed/expanded, mobile, actual integration entrance, no runtime errors; 14 checks pass.

### Task 2: Verification and delivery

**Files:** update README feature instructions and `docs/dynamic-island-verification.md`.

- [x] Run `npm test` (1216 pass), `npm run check`, `npm run deploy:check`; report baseline cache setup issue separately.
- [x] Independent diff review, fix material findings with targeted regressions.
- [x] Commit only this feature on `feat/agent-dynamic-island`, leave the worktree available.

## Ledger

- Ruling: User's request to develop the shown preview supplies implementation authorization; no repeated design approval gate.
- Ruling: Git branch means committed `feat/qingdan-mcp` HEAD. Existing uncommitted Agent changes stay in source; feature can later rebase on them after they are committed.
- Pre-flight: tests and component share the public labels/props above; no worker protocol changes.
- Task 1: complete; 12 target tests pass. New preferences and component observed RED before implementation.
- Final review: two P2 interaction findings fixed (keyboard focus leaving / pinned visibility restoration); both regressions observed RED then GREEN.
- Ruling: <=600px navigation scrolls horizontally at the existing 64px height — keeps all actions reachable without changing canvas sizing.
- Task 2: complete; final full suite 1216/1216, typecheck and deploy dry-run pass. Browser checks use synthetic data and have no external requests; no live account/Runner validation claimed.
