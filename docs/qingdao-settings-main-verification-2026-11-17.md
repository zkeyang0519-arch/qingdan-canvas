# 轻岛配色与软件更新联合合并

范围：轻岛设置面板、检查与重启更新入口、历史外观图片，以及林间苔绿清透玻璃与原版色块流动的独立调色。保留原有任务、拖动、悬停、输入恢复和原生窗口几何。

## 更新链路

1. 展开轻岛，点击设置，在「版本更新」点击「检查更新」。
2. `DesktopUpdateCheck` → preload IPC → `createUpdateController.check()` → `electron-updater.checkForUpdates()`。更新源由安装包配置，网页不能指定地址。
3. 原生更新器发现正式新版后自动下载；界面显示进度。未下载完成时不允许安装。
4. 下载完成后，版本更新栏显示「重启更新」，上方原有更新提示仍可使用。同一个 `installUpdate()` 入口先等待待办与输入草稿保存、刷写存储及 Cookie，再调用 `quitAndInstall(true, true)`。
5. 保存失败不会安装或丢弃下载包，界面保留错误并可重试；重复点击不会触发多次安装。普通退出不自动安装。

原生更新控制器、IPC 与安装流程已存在于基础版本；本次将手动检查及同栏安装入口接入新的设置面板。Tauri 预览版和未打包开发环境沿用各自 bridge 的实际能力，不声称具备 Electron 正式版的更新能力。

## 本地验证

- `node --test tests/desktop-island-ui.test.mjs tests/desktop-update-runtime.test.mjs`：51/51 通过。
- 新增联动用例把真实设置组件连接到真实更新控制器，仅替换下载事件与最终 OS 安装动作，验证检查、进度、就绪、保存失败、重试、只安装一次，以及待办、草稿和配色不变。
- 浏览器已确认同栏出现「重启更新」，点击后显示「正在保存…」并完成演示。预览不下载软件或重启客户端，演示版号有明确标注；截图为 `output/island-colors-20261117/update-ready.jpg`。这不能替代已发布安装包之间的真实升级验收。
- 在独立工作树 `D:/TODO/qingdan-island-main-check-20261117` 验证功能提交 `f6ea95b`，未带入原工作区的 Agent 安装和聊天恢复测试改动。
- `npm test`：1701/1701 通过，无失败、跳过或取消。
- `npm run check` 与 `npm run deploy:check` 均通过，后者仅构建及 dry-run，没有部署。
- 日志归档于 `output/island-main-verification/`。初次配色验收的旧记录仍见 `qingdao-color-versions-verification-2026-11-17.md`。

合入 `main` 会触发现有 Windows 安装包构建流程；该流程仅在版本标签上发布正式更新。此次不创建新版本标签，也不把源码合并当成已发布客户端升级。
