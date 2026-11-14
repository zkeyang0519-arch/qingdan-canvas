# 轻单协作画布

这是独立的 React + Cloudflare Workers 项目，不是 `cloudflare-docs` 文档站点。

- 工作目录：`D:/TODO/qingdan-canvas`。不要修改父目录原项目。
- 仅保留 `feat/qingdan-mcp`（Agent 日常开发）和 `main`（生产）两个分支。默认在 `feat/qingdan-mcp` 继续开发、验证，再按用户授权合入 `main`；保留现有分支名称，除非用户另有要求，不新建功能分支。
- 包管理器：npm；Node.js >= 24。`npm ci` 安装。
- 开发：`npm run dev`（Node.js 24+；自动构建网页和 Runner、迁移本地 D1，同时启动 127.0.0.1:8788 网页服务与 127.0.0.1:8790 Agent 入口）。
- 验证：`npm test`、`npm run check`、`npm run deploy:check`。
- 重要：测试启动独立 workerd；不要与已有开发数据目录混用。
- 真实验收需要测试账号时，隔离应用与 Runner 状态，不能占用用户正在使用的设备绑定；结束时核对用户实际登录账号与电脑在线状态。
- 多人协作使用每画布一个 SQLite DO。对象版本与操作回执不可绕过。
- 画布手势会从快照计算位置，调用 update 时必须提供 `source`，由同步适配层合并到最新状态。
- 真实部署由用户手动按 `docs/cloudflare-setup.md` 操作；先应用 D1 迁移再发布代码，APP_ENV 必须为 production。本地和线上均要求账号登录。
- 不提交 `.dev.vars`、Cookie、邀请令牌或 API 密钥。
