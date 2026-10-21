# Cloudflare 部署进度

更新日期：2026-10-21。下列线上状态依据用户提供的部署输出；本次没有重新部署云端。

## 已有线上资源

- Worker：`qingdan-canvas`，地址 <https://qingdan-canvas.zkeyang0519.workers.dev>。
- D1：`qingdan-canvas`，ID `10b38932-94ba-4f29-8b50-9ba2313db9c2`，绑定 `DB`。此前旧数据库已由用户删除重建。
- R2：`qingdan-canvas-files`，绑定 `FILES`，已由用户创建。
- Durable Object：`CanvasRoom`，绑定 `ROOMS`，SQLite 迁移 `v1`。
- 初始 D1 迁移 `0001_initial.sql` 已由用户执行成功。

## 账号版本待用户上线

本地新增用户名/密码注册登录、个人画布归属、旧访客认领、修改密码和退出。邀请协作保留；`CREATE_KEY` 不再用于创建画布。

按顺序在 `D:\TODO\qingdan-canvas` 执行：

```powershell
npm run db:remote
npm run deploy
```

第一条应用 `0002_accounts.sql`；成功后再运行第二条。无需重新创建 D1、R2 或 Durable Object。详见 [升级步骤](cloudflare-setup.md#已有网站升级到账号版本)。
