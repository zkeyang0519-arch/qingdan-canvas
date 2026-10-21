# Cloudflare 部署进度

更新日期：2026-10-21。

## 已完成

- Wrangler OAuth 登录验证通过；账号 ID 为 `d6997d4bf6dea6be5f3a1ddfe225cab0`。
- 新建独立 D1 数据库 `qingdan-canvas`，位于 APAC；ID 为 `07038c34-6548-48ca-aeb4-3ff47b963395`。
- `wrangler.jsonc` 已填入账号和真实数据库 ID，保留绑定名 `DB`。
- 远程迁移 `0001_initial.sql` 已应用，并通过只读查询确认 `sessions`、`rooms`、`members`、`assets` 业务表存在。
- 部署脚本改用 JSONC 解析器，支持注释与尾逗号，同时保留生产环境和 D1 占位值检查。新增 3 项回归测试，完整测试为 70 项通过，类型检查通过。
- `node scripts/deploy.mjs --check` 通过；此命令只验证配置，不发布。

账号中原有的 `learn-db` 没有用于本项目。

## 当前待办

R2 API 返回 `10042: Please enable R2 through the Cloudflare Dashboard`。需要账号持有人在控制台完成 R2 开通；支付方式和服务条款由持有人处理。

入口：[Cloudflare 控制台](https://dash.cloudflare.com/) → Storage & databases → R2 → Overview。具体要求见 [R2 官方入门文档](https://developers.cloudflare.com/r2/get-started/)。

开通后继续：

1. 创建私有桶 `qingdan-canvas-files`，绑定 `FILES`。
2. 执行 `npm run deploy`，发布 `qingdan-canvas`，注册 `CanvasRoom` Durable Object 类。
3. 设置 `CREATE_KEY`，用于限制新画布创建。
4. 检查线上静态页面、D1 会话、邀请、双 WebSocket 协作和 R2 图片。

**当前尚未创建 R2 桶，也未发布 Worker。尚无项目公网地址。**
