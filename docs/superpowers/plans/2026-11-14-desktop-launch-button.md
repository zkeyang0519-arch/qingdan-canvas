# 网页启动桌面悬浮窗 Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement the independent launcher and renderer tasks; integrate and verify the authenticated local endpoint afterward.

**Goal:** 点击网页顶部「桌面悬浮窗」即可启动或唤起已有桌面窗口，无需每次输入命令。

**Architecture:** 复用现有 8790 本机入口，提供固定的 POST /api/local-desktop/launch。先验证 Host、Origin、本机标记及上游账号会话，再调用与命令行共用的固定 Electron 启动器；原有 Electron 单实例锁负责唤起窗口。网页保留原灵动岛模式，另加启动按钮和进度/错误提示。

**Tech Stack:** React、Node.js 24+、Electron 45.3.2，npm。

**Spec:** 本文同时记录本次小功能设计；延续 docs/superpowers/specs/2026-11-13-desktop-island-design.md 的独立会话、单实例和同步约束。

## Constraints and review focus

- 直接修改 D:/TODO/qingdan-canvas 原 Agent 分支，保留已有未提交内容，不部署。
- 接受空 JSON 对象；不接受网址、命令、路径、账号等启动参数。无有效会话不能启动。
- 仅允许本机入口及现有 8788/5178 开发网页跨端口请求；线上按钮说明如何打开本机入口，不能静默请求回环地址。
- 重复点击不能并发下载/启动；已运行时依赖现有 Electron 单实例恢复窗口。
- 原有桌面登录、Runner 绑定、草稿和业务同步不变。测试使用独立端口和档案。
- 明确区分已发出启动请求与原生窗口就绪；下载、服务离线和启动错误有可重试提示。

## Tasks

- [x] 共享桌面启动器：先覆盖运行时缺失、固定参数、并发、失败清理，再迁移 CLI。
- [x] 网页按钮：覆盖忙碌、成功、失败、重复点击、远端页面和账号变化。
- [x] 本机 API：覆盖身份、来源、请求体、上游故障，接入 dev-agent。
- [x] 集成审查、相关测试、npm test（1505/1505）、npm run check、npm run deploy:check；另通过12项隔离原生验收。
- [x] 更新使用说明，在不打断活动任务的前提下让本机服务载入新功能。
