# 网页灵动岛验收 · 2026-11-13

## 分支与范围

工作分支 `feat/agent-dynamic-island` 从 Agent 开发分支 `feat/qingdan-mcp` 的 `ea47f8b` 创建。独立工作树位于 `C:/Users/26437/.codex/worktrees/agent-dynamic-island/qingdan-canvas`，原 `D:/TODO/qingdan-canvas` 的未提交内容保留原处。本次未包含那些尚未提交的 Agent 改动。

顶部开关启用网页内胶囊；任务读取及修改复用现有 workspace 与排列项目模型，无后端变更。手机导航保持一行，高度不变，超出内容可横向滚动。

## 验证

- 目标行为与偏好测试：12/12 通过。
- `npm run check` 通过。
- `npm run deploy:check` 通过，仅 dry-run；保留原有大 chunk 提示。
- Chromium 隔离验收 14 项通过：实际 CanvasWorkspace 导航开启、hover/延迟收起、钉住、勾选、多行单条新增、Escape 焦点、320px 触屏和横向导航可达、长列表内部滚动。无运行异常、控制台错误或外部请求。
- 浏览器验收只替换同步 hook 为合成数据，保留真实组件及任务模型；未登录真实账号、连接用户 Runner 或访问开发数据库。临时随机端口服务器已经关闭。
- 审查修复后的最终 `npm test`：1216/1216 通过，0失败、0跳过（210秒）。

首次干净依赖安装缺少 `node_modules/.cache`，导致18个已有测试的 mkdtemp 失败；创建该测试缓存目录后，首轮全量回归1214/1214通过。这是测试环境准备问题，未修改业务代码绕过测试。

## 独立审查与修复

审查确认两个P2边界：键盘打开后Tab离岛不收起；钉住状态经过外部弹层暂隐后不恢复展开。两项均先通过正式回归观察失败，再修复，并完成目标测试复验。

源代码和测试位于 `src/island/`、`tests/dynamic-island-ui.test.mjs`、`tests/island-preferences.test.mjs`。浏览器脚本、合成数据、截图及日志位于忽略目录 `.tmp/island-verification/`，不属于产品数据。

## 交付边界

- 仅网页内悬浮，不提供系统桌面置顶。
- 胶囊项目名始终明确显示；与 Agent 面板内部的项目选择独立。
- 草稿按项目留在当前面板会话；关闭灵动岛或刷新不承诺恢复未提交输入。
- 保留 feature 分支供继续开发，不合并、推送或发布。
