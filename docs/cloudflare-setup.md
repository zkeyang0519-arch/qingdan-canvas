# 一起连接 Cloudflare

工程基础已经准备好。以下是首次连接时的完整步骤，所有命令都在 `D:\TODO\qingdan-canvas` 运行。

已有 D1、R2 和 Worker，无需重复创建。以下第 1–5 节是首次建站参考；本次账号版本请先按下面的升级步骤操作。实际进度见 [部署记录](deployment-status.md)。

## 已有网站升级到账号版本

1. 旧访客先等待“已同步”，需要时导出备份。保留原浏览器 Cookie，升级后用它认领旧画布。
2. 在项目终端执行 `npm run db:remote`，确认目标为 `qingdan-canvas`，应用未执行的迁移，包括 `0002_accounts.sql`、`0003_account_avatars.sql`、`0004_account_email_recovery.sql` 和 `0005_registration_email.sql`。它们新增账号、头像版本、邮箱字段及验证码表，不删除画布、旧会话或图片。
3. 成功后再执行 `npm run deploy`，发布注册登录页面与权限逻辑。不要只部署代码而漏掉迁移。
4. 按下面的邮件配置完成发信设置，再打开线上网站，填写用户名、邮箱、密码及可选昵称，通过邮箱验证码注册。若发现旧画布，勾选归入此账号；原房间、图片、灵感板和邀请继续保留。
5. 在另一个浏览器登录同一账号，确认能看到原来的画布。再用另一个账号测试邀请协作。

这些云端命令由你操作。本地测试账号和本地画布不会上传。`CREATE_KEY` 已不再使用，无需重新设置或删除。

已经使用账号版本的网站升级头像功能时，也要先执行 `npm run db:remote`（预览站用 `npm run db:preview`）应用 `0003_account_avatars.sql`，再发布代码。头像复用私有 R2 桶，由本人或共享画布的成员登录后读取。该迁移只是新增可空字段，回退旧代码时可以保留，无需删除账号或画布。

密码使用原生 scrypt 哈希（N=16384、r=8、p=5），按 [OWASP 的配置](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt)控制内存；[Workers 支持 Node crypto](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/)。发布验收时要检查注册/登录的实际 CPU 使用是否符合账号的 Worker 配额；本地运行不模拟线上 CPU 限制。若遇到 CPU 超限，应调整运行配额或采用托管认证，不应降低密码哈希强度。

## 邮箱找回密码与头像裁剪升级

先执行 `npm run db:remote`（预览站用 `npm run db:preview`），应用 `0004_account_email_recovery.sql` 和 `0005_registration_email.sql`。前者新增已验证邮箱字段及绑定/找回验证码表，后者新增注册验证码表，均不改已有密码、画布或头像。确认迁移成功后再发布新代码。

邮件通过 [Resend Send Email API](https://resend.com/docs/api-reference/emails/send-email) 发送。先在 Resend 验证自己的发信域名，创建发送权限的 API Key，再给 **目标 Worker** 配置以下三个变量。生产和分支预览需要分别配置，不能假设生产密钥会自动传入预览站。

| 名称                | 内容                                                                |
| ------------------- | ------------------------------------------------------------------- |
| `RESEND_API_KEY`    | Resend 的发送 API Key，保存为 Worker secret                         |
| `EMAIL_FROM`        | 已验证域名的发信地址，例如 `轻单 <noreply@你的域名>`                |
| `EMAIL_CODE_SECRET` | 独立随机密钥，至少 32 个字符，用于验证码 HMAC，保存为 Worker secret |

生产站可以在本项目终端输入：

```powershell
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put EMAIL_FROM
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))" | npx wrangler secret put EMAIL_CODE_SECRET
```

前两个命令分别提示输入 API Key 和发信地址；第三个命令把生成的随机密钥直接交给 Wrangler。不要把密钥粘贴进源码、聊天或 `wrangler.jsonc`。本地开发可参考 `.dev.vars.example` 创建未跟踪的 `.dev.vars`；不要覆盖已有配置。

配置完成后按原部署流程运行检查并发布。新注册必须先验证邮箱；若未配置邮件会提示服务尚未启用，不能跳过验证注册。已有账号仍可正常登录及使用头像、画布等功能。

仅升级注册强制绑定邮箱时，也须先应用 `0005_registration_email.sql`。已有三个邮件变量可继续使用，无需更换密钥。注册验证码在独立表中暂存，邮箱验证成功才创建账号并自动绑定邮箱；填写表单或发送验证码不会占用账号。发送接口对已被使用的用户名或邮箱返回统一提示，不发送注册邮件；可使用已有账号登录或找回密码。

使用与验收：

1. 新用户在注册页填写邮箱，发送并输入六位验证码，设置密码后注册，邮箱自动绑定。尚未绑定的旧账号可登录后打开“账号设置 → 绑定邮箱与找回密码”补绑；已经忘记密码且从未绑定邮箱的账号，需要先由管理员恢复登录，再补绑邮箱。
2. 退出后在登录页选择“忘记密码”，输入用户名和已验证邮箱，获取验证码并设置新密码。重置成功后使用新密码登录，其他设备的旧登录会失效。
3. 验证码 10 分钟内有效，最多尝试 5 次；重发间隔 60 秒，另有每小时发送上限。重发后旧码失效；改密、改绑或成功使用后，相关旧验证码均不能继续使用。找回请求不会透露用户名或邮箱是否匹配。
4. 上传头像后先调整圆形选区，可移动圆圈、改变范围、缩放原图；确认才保存。取消保留旧头像，导出的 256×256 头像圈外为透明，GIF 使用静态画面。

自动化邮件测试只连接本地模拟邮件服务，不会发送真实邮件：

```powershell
node --test tests/email-recovery.test.mjs tests/email-recovery-worker.test.mjs
```

上线后仍需用自己的邮箱检查一次真实投递及垃圾邮件情况。更换 `EMAIL_CODE_SECRET` 会使尚未使用的验证码失效，需要重新获取。

## 1. 登录账号

```powershell
cd D:\TODO\qingdan-canvas
npx wrangler login
npx wrangler whoami
```

`login` 会打开 Cloudflare 授权页面，由你完成登录和授权。不要把 API Token、密码或验证码贴进聊天。若账号下有多个 Cloudflare Account，先确认用于本项目的账号，再在 `wrangler.jsonc` 添加其 `account_id`。

## 2. 创建 D1 数据库

```powershell
npx wrangler d1 create qingdan-canvas
```

命令会返回 `database_id`。将 `wrangler.jsonc` 中 D1 的全零占位 ID 替换为真实 ID，保留：

```json
{
  "binding": "DB",
  "database_name": "qingdan-canvas",
  "database_id": "这里填写命令返回的真实 UUID",
  "migrations_dir": "migrations"
}
```

如果命令提示自动修改配置，检查生成的绑定名必须是 `DB`，迁移目录必须仍为 `migrations`。名字和 ID 不是密钥，可用于核对配置。

## 3. 创建 R2 桶

先在 Cloudflare 控制台确认当前账号已启用 R2。若页面要求设置支付方式或接受计费条款，由你完成；不要为了本地开发开通这些服务。

```powershell
npx wrangler r2 bucket create qingdan-canvas-files
```

检查配置：

```json
{ "binding": "FILES", "bucket_name": "qingdan-canvas-files" }
```

保持桶私有。此项目通过 Worker 读写桶，**不需要 R2 Access Key、公开 r2.dev 域名或桶 CORS 设置**。

## 4. 应用远程数据库迁移

```powershell
npm run db:remote
```

这里的 `--remote` 会写入真实 D1。先确认命令显示的是刚创建的 `qingdan-canvas`。本地测试用的是 `npm run db:local`，两者数据相互独立。

迁移创建所需表并添加新字段。原 `D:\TODO` 的浏览器数据和本地开发画布不会自动上传。

## 5. 检查并部署 Worker

```powershell
npm test
npm run check
npm run deploy:check
npm run deploy
```

部署前检查 `wrangler.jsonc`：

- `APP_ENV` 必须为 `production`。
- D1 是真实 `database_id`，绑定名是 `DB`。
- R2 桶已经创建，绑定名是 `FILES`。
- `ROOMS` 对应 `CanvasRoom`。
- DO 第一次部署使用 `v1` 的 `new_sqlite_classes` 迁移；已经部署后不要删掉或重写既有迁移，后续增加新的迁移 tag。

首次部署会注册 Durable Object 类，房间实例在首次打开时创建。命令最后返回实际 `workers.dev` 地址，这就是分享给其他电脑的入口。

## 6. 注册轻单账号

打开部署地址，填写用户名、邮箱与密码，昵称可选。发送并输入六位邮箱验证码后才能注册；验证码 10 分钟内有效，60 秒后可重发，最多尝试 5 次。用户名不区分大小写，密码需要 9–128 个字符。注册成功时邮箱已绑定，可以直接新建自己的画布，其他账号只有通过邀请加入后才能查看和编辑。

密码只保存加盐哈希。账号设置支持修改密码、更换已验证邮箱和退出登录。注册邮箱可直接用于在登录页通过验证码找回密码；日常登录仍使用用户名和密码。请妥善保存账号信息，不要贴进聊天或提交到源码。

## 7. 两个浏览器验收

1. 浏览器 A 打开部署地址，注册账号 A 并创建画布。
2. 新建清单，添加图片，等待“已同步”。
3. 创建者复制邀请链接，在浏览器 B 或另一台电脑打开，注册或登录账号 B；登录成功后自动加入邀请中的画布。
4. A 勾选任务，确认 B 自动收到变化；B 新建便签，确认 A 自动出现。
5. 两边刷新，确认文字和图片还在。
6. 断开 B 的网络，修改文字；恢复网络，确认重连并合并，或出现明确的冲突提示。
7. 重置邀请，用未加入过的第三个浏览器验证旧链接已失效。现有 B 成员仍可访问，这是当前产品规则。
8. B 退出后登录账号 A，确认个人画布与创建者权限保持一致；再验证修改密码后其他旧登录会话失效。

## 8. 自定义域名与登录

基础验收通过后，再做这两项：

- 在 Worker 的 Settings → Domains & Routes 绑定你的自定义域名。网页、HTTP API 和 WebSocket 都使用同一域名，无需分别配置地址。
- 如果要邮箱登录和团队身份管理，接 Cloudflare Access。它需要在 Worker 验证 Access JWT 并把稳定身份映射到成员表；仅在前端显示登录按钮不构成权限实现。当前工程还没有做这一步。

之后可以增加成员移除、只读邀请、备份恢复、审计、对象回收和容量策略。

## 排查

### Git 分支预览构建

Cloudflare Workers Builds 的非生产分支使用 `npx wrangler preview`。这个命令要求 `wrangler.jsonc` 声明 `previews`，并显式提供 `APP_ENV`、`DB`、`FILES`、`ROOMS`；顶层的这些设置不会自动继承到预览环境。

首次连接 `develop` 预览时，由你在项目目录执行：

```powershell
npx wrangler d1 create qingdan-canvas-preview
npx wrangler r2 bucket create qingdan-canvas-preview-files
```

两个命令询问自动修改配置时都选 **No**，避免把预览资源追加到生产绑定。将新 D1 返回的 `database_id` 填入这两处：

- `wrangler.jsonc` → `previews.d1_databases[0].database_id`。
- `wrangler.preview-migrations.jsonc` → `d1_databases[0].database_id`。

当前预览库为 `qingdan-canvas-preview`（`9cb763c2-d1dc-41a6-8899-d38cec0e0060`），配置已填写；已创建资源后直接初始化预览数据库：

```powershell
npm run db:preview
```

确认命令目标为 `qingdan-canvas-preview`，首次会依次应用 `0001_initial.sql`、`0002_accounts.sql`、`0003_account_avatars.sql`、`0004_account_email_recovery.sql` 和 `0005_registration_email.sql`。这个命令使用独立的迁移配置，操作预览数据库。用于生产库的命令仍是 `npm run db:remote`。

完成后提交并推送配置到 `develop`，让 Workers Builds 重新运行。Cloudflare 的构建设置应为：

| 设置                                | 值                     |
| ----------------------------------- | ---------------------- |
| Build command                       | `npm run build`        |
| Production deploy command（`main`） | `npx wrangler deploy`  |
| Preview deploy command（`develop`） | `npx wrangler preview` |

`ROOMS` 使用本 Worker 导出的 `CanvasRoom`，没有 `script_name`，Cloudflare 会为每个预览自动创建独立的 Durable Object 命名空间。保留顶层现有的 `v1` 迁移即可，不需要手动创建 DO。静态文件 `assets` 也保留在顶层。

预览站有独立的账号和画布，需要重新注册。以上 D1 和 R2 用于 `develop` 预览；若同时预览其他分支，为那些分支配置各自的 D1 和 R2，保持画布目录与各分支独立的 DO 数据一致。

`npm run deploy:check` 只验证生产配置的本地打包，不能验证预览资源是否已创建或云端部署权限。预览部署继续使用 `wrangler preview`；`wrangler deploy` 会发布生产站。

配置依据：[预览配置](https://developers.cloudflare.com/workers/previews/configuration/)、[Durable Object 隔离](https://developers.cloudflare.com/workers/previews/resources/#durable-objects)、[预览 D1 迁移](https://developers.cloudflare.com/workers/previews/resources/#d1-migrations)。

### 线上运行日志

```powershell
npx wrangler tail
```

只在排查线上问题时打开日志。不要把完整邀请链接或 Cookie 写进业务日志。

| 现象                   | 先检查                                                   |
| ---------------------- | -------------------------------------------------------- |
| 仍要求创建口令         | 网页或 Worker 仍是旧版，确认迁移及部署成功后刷新         |
| `no such table`        | 是否对正确的 D1 执行 `npm run db:remote`                 |
| 图片上传失败           | R2 是否启用、桶名是否匹配、图片格式及大小                |
| WebSocket 连不上       | 浏览器是否加入画布、域名是否同源、代理是否支持 WebSocket |
| 邀请失效               | 是否复制完整 `#invite=...`，是否已被创建者重置           |
| 换浏览器后看不到旧画布 | 是否登录同一账号，旧访客是否在原浏览器认领过画布         |

实现参考：[WebSocket Hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)、[Wrangler 配置](https://developers.cloudflare.com/workers/wrangler/configuration/)、[本地资源](https://developers.cloudflare.com/workers/local-development/local-data/)、[Worker 静态资源路由](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)。
