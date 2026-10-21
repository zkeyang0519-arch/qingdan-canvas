# 轻单协作画布 Implementation Plan

**Goal:** 提取原画布，交付本地可运行的 Cloudflare 多人协作基础及中文部署步骤。
**Architecture:** 单 Worker 提供静态资源和 API；每画布一个 SQLite Durable Object；D1 管成员、R2 管图片。
**Tech Stack:** React 19、Vite、TypeScript、Wrangler、Node test runner。
**Spec:** [design.md](design.md)

## Global Constraints

- 原项目不修改。新工程 `D:/TODO/qingdan-canvas-cloud` 独立安装。
- 本轮不创建远程资源；邀请链接方式已由用户确认。
- 使用 SQLite DO 休眠 WebSocket。图片限制 10 MiB。
- 不包含 Agent、Codex 本机执行器、模型设置或模型密钥。

## Review Focus

- 同时编辑同清单不同事项可合并，同一文本冲突可恢复。
- 重连重复操作不重复提交，刷新不丢未确认草稿。
- 房间成员不能读写其他房间或其他房间图片。
- 收纳多对象移动原子提交，撤销不覆盖别人。
- 上传失败不出现虚假保存状态；共享新图片可在另一成员显示。

## Tasks

- [x] 1. 提取画布纯组件、数据模型和原有相关回归测试，建立独立构建与配置。检查外部引用。
- [x] 2. 先写同步合并、冲突及撤销测试，再实现 `src/sync/replica.js`。
- [x] 3. 先写真实运行时协作与权限集成测试，再实现 `worker/index.ts`、`worker/room.ts`、`worker/auth.ts` 和 D1 迁移。
- [x] 4. 实现画布列表、加入、分享及 `useRoomWorkspace`；用原 Canvas 组件替换本机存储连接层。
- [x] 5. 运行单元、集成、类型、构建、dry-run 和浏览器验证，修复发现的问题，独立审查。
- [x] 6. 保存测试记录、启动脚本与 Cloudflare 部署指南，打开本地预览，交接下一步登录。

结果见 [验证记录](verification.md)。后续远程资源配置按 [Cloudflare 部署指南](cloudflare-setup.md) 执行。
