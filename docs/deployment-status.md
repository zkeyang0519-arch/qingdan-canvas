# Cloudflare 部署进度

更新日期：2026-10-23 18:52（北京时间）。本次经用户明确授权，已推送注册时验证并绑定邮箱的改动，应用生产数据库迁移并完成 Worker 部署，核对线上结果。

## 已有线上资源

- Worker：`qingdan-canvas`，地址 <https://qingdan-canvas.zkeyang0519.workers.dev>。
- D1：`qingdan-canvas`，ID `10b38932-94ba-4f29-8b50-9ba2313db9c2`，绑定 `DB`。此前旧数据库已由用户删除重建。
- R2：`qingdan-canvas-files`，绑定 `FILES`，已由用户创建。
- Durable Object：`CanvasRoom`，绑定 `ROOMS`，SQLite 迁移 `v1`。
- D1 已应用 `0001_initial.sql`、`0002_accounts.sql`、`0003_account_avatars.sql`、`0004_account_email_recovery.sql` 和 `0005_registration_email.sql`。

## 当前上线版本

- 源码提交：`962263e`，已推送至 GitHub `develop`；新增注册时必须验证并绑定邮箱，保留已有账号登录、忘记密码及 20 MB 原图圆形头像裁剪功能。
- 当前 Worker 版本：`1844bd59-4ced-4904-8ea9-fc7b0d85e249`，承接 100% 生产流量，发布时间为 2026-10-23 18:51（北京时间）。
- `APP_ENV` 为 `production`；D1、R2 和 Durable Object 绑定保留。
- `RESEND_API_KEY`、`EMAIL_FROM`、`EMAIL_CODE_SECRET` 均保存为 Worker Secret，实际值不写入仓库。
- 发信域名 `todo.poppin.cn` 已在 Resend 显示 Verified，Sending 已启用。

## 本次注册邮箱验证发布（18:52）

- 新用户先获取邮件中的 6 位验证码，验证成功后同时创建账号、绑定邮箱并建立会话；已有账号登录不受影响。
- 已先应用生产迁移 `0005_registration_email.sql`，确认注册验证码表及三个索引存在，再推送代码并执行 `npm run deploy`。
- 迁移前后账号数 5、画布数 4、成员关系数 7、资源记录数 1，均保持一致。
- 发布前重新运行 265 项测试、`npm run check`、`npm run deploy:check` 和格式检查，全部通过。独立代码审查与本地浏览器表单、验证码冷却及页面滚动检查已完成。
- 线上主脚本为 `index-DThGAm3H.js`，SHA-256 为 `ea6a191f57dd86b854d337bc0a586c5e4a36f8696513f14700735f64873b37ee`，与本地发布构建一致。
- 首页、`/api/health`、无 Cookie 和无效会话 Cookie 的 `/api/session` 均返回 200；环境为 production。
- 线上注册验证码请求的空输入返回 400 用户名校验错误；直接提交缺少验证码的注册请求返回 400 验证码错误，不创建会话。本轮检查未发送真实邮件。
- 再次确认三个邮件 Secret 保留，且新版承接 100% 生产流量。

## 此前头像上限调整与验证（17:57）

- 原图最大 20 MB；裁剪后仍为 256×256 WebP，编码质量保持 0.85。页面提示与错误提示已同步。
- 243 项测试、`npm run check`、`npm run deploy:check` 及格式检查通过。现有裁剪测试覆盖恰好 20 MB 可编辑导出、超过 20 MB 拒绝，以及导出尺寸不变。
- 生产 D1 无待应用迁移；本次通过 `npm run deploy` 发布，没有数据库结构变更。
- 线上主脚本为 `index-CrfI2uFW.js`，文件 SHA-256 与本地验证过的构建产物一致，包含 20 MB 上限提示。
- 首页、`/api/health` 及无 Cookie、无效会话 Cookie 的 `/api/session` 均返回 200；线上环境为 production。
- 三个邮件 Secret 与生产数据库绑定均已确认保留。

## 此前恢复与验证（17:39）

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
