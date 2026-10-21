# 一起连接 Cloudflare

工程基础已经准备好。以下是首次连接时的完整步骤，所有命令都在 `D:\TODO\qingdan-canvas` 运行。

已有 D1、R2 和 Worker，无需重复创建。以下第 1–5 节是首次建站参考；本次账号版本请先按下面的升级步骤操作。实际进度见 [部署记录](deployment-status.md)。

## 已有网站升级到账号版本

1. 旧访客先等待“已同步”，需要时导出备份。保留原浏览器 Cookie，升级后用它认领旧画布。
2. 在项目终端执行 `npm run db:remote`，确认目标为 `qingdan-canvas`，应用新的 `0002_accounts.sql`。它只新增账号等表，不删除画布、旧会话或图片。
3. 成功后再执行 `npm run deploy`，发布注册登录页面与权限逻辑。不要只部署代码而漏掉迁移。
4. 打开线上网站，首次注册用户名、昵称和密码。若发现旧画布，勾选归入此账号；原房间、图片、灵感板和邀请继续保留。
5. 在另一个浏览器登录同一账号，确认能看到原来的画布。再用另一个账号测试邀请协作。

这些云端命令由你操作。本地测试账号和本地画布不会上传。`CREATE_KEY` 已不再使用，无需重新设置或删除。

密码使用原生 scrypt 哈希（N=16384、r=8、p=5），按 [OWASP 的配置](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt)控制内存；[Workers 支持 Node crypto](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/)。发布验收时要检查注册/登录的实际 CPU 使用是否符合账号的 Worker 配额；本地运行不模拟线上 CPU 限制。若遇到 CPU 超限，应调整运行配额或采用托管认证，不应降低密码哈希强度。

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

迁移只创建表。原 `D:\TODO` 的浏览器数据和本地开发画布不会自动上传。

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

打开部署地址，注册用户名与密码，昵称可选。用户名不区分大小写，密码需要 12–128 个字符。注册后可以直接新建自己的画布，其他账号只有通过邀请加入后才能查看和编辑。

密码只保存加盐哈希。账号设置支持修改密码和退出登录，暂不支持邮箱验证或找回密码。请妥善保存账号信息，不要贴进聊天或提交到源码。

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

确认命令目标为 `qingdan-canvas-preview`，首次会应用 `0001_initial.sql` 和 `0002_accounts.sql`。这个命令使用独立的迁移配置，操作预览数据库。用于生产库的命令仍是 `npm run db:remote`。

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
