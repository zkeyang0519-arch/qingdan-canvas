# 轻单协作画布

这是独立的 React + Cloudflare Workers 项目，不是 `cloudflare-docs` 文档站点。

- 工作目录：本仓库根目录（原开发机为 `D:/TODO/qingdan-canvas`）。不要修改父目录中的其他项目。维护交接从 `docs/MAINTAINER-HANDOFF.md` 开始阅读。
- 仅保留 `feat/qingdan-mcp`（Agent 日常开发）和 `main`（生产）两个分支。默认在 `feat/qingdan-mcp` 继续开发、验证，再按用户授权合入 `main`；保留现有分支名称，除非用户另有要求，不新建功能分支。
- 包管理器：npm；Node.js >= 24。`npm ci` 安装。
- 开发：`npm run dev`（Node.js 24+；自动构建网页和 Runner、迁移本地 D1，同时启动 127.0.0.1:8788 网页服务与 127.0.0.1:8790 Agent 入口）。
- 验证：`npm test`、`npm run check`、`npm run deploy:check`。
- 轻岛每次发布新版本（正式版或验证版），必须同步线上下载界面 `https://todo.zky.lol/download/` 的对应版本号、安装包和更新说明链接；源码更新、GitHub Release 或本机升级都不能代替线上下载页验收。正式版先运行 `npm run desktop:download:check`，发布后运行 `npm run desktop:download:check -- --online --wait`；线上未同步不得宣布发布完成。保持正式版与验证版渠道分开，保留仍受支持的平台入口。
- 轻量版使用 `npm run desktop:download:check -- --preview` 核对下载页，发布后使用 `npm run desktop:download:check -- --preview --online --wait` 验证 Windows 和两种 Mac 安装包，以及轻量版更新说明。
- Windows 正式版使用安装包内置网页；即使只修改轻岛前端，也必须提升桌面版本、打包并发布正式更新，旧客户端仅重启不会加载网站的新页面。本机替换资源只能用于诊断，不能代替其他用户的升级交付。新增静态资源要验证随包分发及离线加载，并运行 `npm run desktop:inspect` 检查包内资源与当前构建一致。
- 重要：测试启动独立 workerd；不要与已有开发数据目录混用。
- 真实验收需要测试账号时，隔离应用与 Runner 状态，不能占用用户正在使用的设备绑定；结束时核对用户实际登录账号与电脑在线状态。
- 多人协作使用每画布一个 SQLite DO。对象版本与操作回执不可绕过。
- 画布手势会从快照计算位置，调用 update 时必须提供 `source`，由同步适配层合并到最新状态。
- 真实部署由用户手动按 `docs/cloudflare-setup.md` 操作；先应用 D1 迁移再发布代码，APP_ENV 必须为 production。本地和线上均要求账号登录。
- 不提交 `.dev.vars`、Cookie、邀请令牌或 API 密钥。
