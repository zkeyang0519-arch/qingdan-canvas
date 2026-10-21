# 一起连接 Cloudflare

工程基础已经准备好。以下是首次连接时的完整步骤，所有命令都在 `D:\TODO\qingdan-canvas-cloud` 运行。

当前账号的登录、D1 创建及远程建表已经完成，后续请从 R2 开通继续，不要重复创建 D1。实际进度见 [部署记录](deployment-status.md)。

## 1. 登录账号

```powershell
cd D:\TODO\qingdan-canvas-cloud
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

## 6. 设置创建口令

```powershell
npx wrangler secret put CREATE_KEY
```

在终端的隐藏输入中输入自选的长随机口令。不要提交到源码或写进 `wrangler.jsonc`。

首次部署到设置口令之间，网页能打开，但“创建画布”会提示管理员尚未配置口令。口令用于限制谁可以新增画布；加入已有画布仍使用邀请链接。

## 7. 两个浏览器验收

1. 浏览器 A 打开部署地址、设置昵称、输入创建口令并创建画布。
2. 新建清单，添加图片，等待“已同步”。
3. 创建者复制邀请链接，在浏览器 B 或另一台电脑打开，设置另一个昵称。
4. A 勾选任务，确认 B 自动收到变化；B 新建便签，确认 A 自动出现。
5. 两边刷新，确认文字和图片还在。
6. 断开 B 的网络，修改文字；恢复网络，确认重连并合并，或出现明确的冲突提示。
7. 重置邀请，用未加入过的第三个浏览器验证旧链接已失效。现有 B 成员仍可访问，这是当前产品规则。

## 8. 自定义域名与登录

基础验收通过后，再做这两项：

- 在 Worker 的 Settings → Domains & Routes 绑定你的自定义域名。网页、HTTP API 和 WebSocket 都使用同一域名，无需分别配置地址。
- 如果要邮箱登录和团队身份管理，接 Cloudflare Access。它需要在 Worker 验证 Access JWT 并把稳定身份映射到成员表；仅在前端显示登录按钮不构成权限实现。当前工程还没有做这一步。

之后可以增加成员移除、只读邀请、备份恢复、审计、对象回收和容量策略。

## 排查

```powershell
npx wrangler tail
```

只在排查线上问题时打开日志。不要把完整邀请链接或 Cookie 写进业务日志。

| 现象                   | 先检查                                                   |
| ---------------------- | -------------------------------------------------------- |
| 创建画布提示口令未配置 | `CREATE_KEY` secret 是否已设置                           |
| `no such table`        | 是否对正确的 D1 执行 `npm run db:remote`                 |
| 图片上传失败           | R2 是否启用、桶名是否匹配、图片格式及大小                |
| WebSocket 连不上       | 浏览器是否加入画布、域名是否同源、代理是否支持 WebSocket |
| 邀请失效               | 是否复制完整 `#invite=...`，是否已被创建者重置           |
| 换浏览器后看不到旧画布 | 匿名身份不同，需要邀请；不会自动继承创建者权限           |

实现参考：[WebSocket Hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)、[Wrangler 配置](https://developers.cloudflare.com/workers/wrangler/configuration/)、[本地资源](https://developers.cloudflare.com/workers/local-development/local-data/)、[Worker 静态资源路由](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)。
