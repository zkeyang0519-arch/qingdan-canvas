# 轻单协作画布

这是独立的 React + Cloudflare Workers 项目，不是 `cloudflare-docs` 文档站点。

- 工作目录：`D:/TODO/qingdan-canvas`。不要修改父目录原项目。
- 包管理器：npm；Node.js >= 22。`npm ci` 安装。
- 开发：`npm run dev`（自动 build、迁移本地 D1、监听 127.0.0.1:8788）。
- 验证：`npm test`、`npm run check`、`npm run deploy:check`。
- 重要：测试启动独立 workerd；不要与已有开发数据目录混用。
- 多人协作使用每画布一个 SQLite DO。对象版本与操作回执不可绕过。
- 画布手势会从快照计算位置，调用 update 时必须提供 `source`，由同步适配层合并到最新状态。
- 真实部署由用户手动按 `docs/cloudflare-setup.md` 操作；先应用 D1 迁移再发布代码，APP_ENV 必须为 production。本地和线上均要求账号登录。
- 不提交 `.dev.vars`、Cookie、邀请令牌或 API 密钥。
