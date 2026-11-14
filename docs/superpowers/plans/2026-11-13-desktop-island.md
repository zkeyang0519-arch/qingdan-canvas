# Desktop Island Implementation Plan

**Goal:** 在原 Agent 工作区交付可操作真实待办的 Windows 置顶悬浮窗。
**Architecture:** Electron host 只管理窗口；现有 App 复用认证/画布路由；DesktopIslandWorkspace 复用唯一同步 workspace。
**Tech Stack:** Electron 45.3.2、React、Node test/JSDOM、隔离 Electron 验收。
**Spec:** `../specs/2026-11-13-desktop-island-design.md`

## Global Constraints

保留原 dirty 工作区，不提交/部署。桌面不管理 Runner。测试不连接用户账号、Runner 或开发数据库。所有新增桥接能力需验证发起页面与数据；窗口按显示器工作区域裁剪。

## Review Focus

失焦不会误提交；退出先完成本地持久化；账号/画布切换不串草稿；错误和冲突有可操作的恢复入口；透明区域和收起尺寸不遮挡其他软件。

### Task 1: Native window host

新增 `desktop/main.cjs`、`desktop/preload.cjs`、`desktop/window-policy.cjs`、`scripts/desktop.mjs` 和 `tests/desktop-window-policy.test.mjs`。先测试 URL/IPC 与几何约束失败，再实现透明置顶、拖动/鼠标穿透、托盘、单实例、失败页和退出保存握手。只写上述文件，包依赖由主代理处理。

### Task 2: Desktop renderer

新增 `src/desktop/` 和相关 UI 测试；修改 `src/App.jsx`、`src/main.jsx`、`src/island/DynamicIsland.jsx`。先测试桌面选择、状态、恢复操作与桥接，再实现 setup frame、DesktopIslandWorkspace 和胶囊可选 props。桥接接口严格遵循 spec；mode 判断只依赖可信 preload 标记。

### Task 3: Durable sync and integration

修改 `src/sync/useRoomWorkspace.js` 的可选身份与保存入口并写行为测试。新增 npm desktop 命令和固定 Electron 依赖，保留已有 package 改动。写启动说明。用实际 Electron + 隔离合成数据验证置顶窗口、收展、移动/显示区域、待办写回、隐藏恢复、单实例和退出。

### Task 4: Verification

目标测试、`npm test`、`npm run check`、`npm run deploy:check`，独立代码审查与实际 Electron 截图。失败先诊断再修复，记录真实结果；复核不相关已有改动未受损。

## 完成记录

- [x] 原生窗口与受限桥接，包含保存/重连保护、Windows置顶修复和稳定位置锚点。
- [x] 复用原认证/画布选择、桌面胶囊、错误恢复及独立拖动区域。
- [x] 固定桌面同步草稿身份与退出前保存，Electron依赖/启动入口/说明。
- [x] 最终58项目标测试、类型检查和部署dry-run通过；32项原生验收通过。
- [x] 完整回归及异常复验、原dirty内容保护核对已记录。原生拖动的自动化限制明确保留，见 `docs/desktop-island-verification.md`。
