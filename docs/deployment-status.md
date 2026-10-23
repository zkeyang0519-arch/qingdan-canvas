# Cloudflare 部署进度

更新日期：2026-10-23 17:39（北京时间）。本次经用户明确授权，已实际完成生产迁移和部署，并核对线上结果。

## 已有线上资源

- Worker：`qingdan-canvas`，地址 <https://qingdan-canvas.zkeyang0519.workers.dev>。
- D1：`qingdan-canvas`，ID `10b38932-94ba-4f29-8b50-9ba2313db9c2`，绑定 `DB`。此前旧数据库已由用户删除重建。
- R2：`qingdan-canvas-files`，绑定 `FILES`，已由用户创建。
- Durable Object：`CanvasRoom`，绑定 `ROOMS`，SQLite 迁移 `v1`。
- D1 已应用 `0001_initial.sql`、`0002_accounts.sql`、`0003_account_avatars.sql` 和 `0004_account_email_recovery.sql`。

## 当前上线版本

- 源码提交：`1851b37`，包含邮箱验证绑定、忘记密码和交互式圆形头像裁剪。
- 当前 Worker 版本：`bf405490-f975-4d3e-8a11-419222e5604c`，承接 100% 生产流量。
- `APP_ENV` 为 `production`；D1、R2 和 Durable Object 绑定保留。
- `RESEND_API_KEY`、`EMAIL_FROM`、`EMAIL_CODE_SECRET` 均保存为 Worker Secret，实际值不写入仓库。
- 发信域名 `todo.poppin.cn` 已在 Resend 显示 Verified，Sending 已启用。

## 本次恢复与验证

- 发现生产库原先只应用到 `0002`，缺少头像字段导致携带会话 Cookie 的 `/api/session` 返回 500。
- 已执行 `npm run db:remote` 补齐 `0003`、`0004`。迁移前后账号数与画布数一致，已有数据保留。
- `npm run check`、`npm run deploy:check` 通过；随后发布新版并将发信地址从普通文本转换为 Secret，保留原值。
- `/api/health` 返回 200，环境为 production；无 Cookie 和无效会话 Cookie 的 `/api/session` 均返回 200。
- 找回密码接口已通过配置检查；空请求按预期返回 400 输入校验错误，检查过程中未发送邮件。
- 生产登录页及“忘记密码”表单已在浏览器确认正常显示。
- 真实收信仍需用户登录后，在“账号设置 → 绑定邮箱与找回密码”完成一次邮箱绑定验证。

## 后续发布

后续新增数据库迁移时，在 `D:\TODO\qingdan-canvas` 按顺序执行：

```powershell
npm run db:remote
npm run deploy
```

迁移命令会跳过已应用的文件；成功后再发布代码。当前三个邮件变量均为 Secret，普通 Wrangler 部署会保留它们。若以后另在控制台添加普通文本变量，应同步到配置文件，或构建后使用 `npx wrangler deploy --keep-vars` 保留控制台配置。详见 [部署说明](cloudflare-setup.md)。
