# 逐步功能体验 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans. 每项实现后运行对应测试；结束时独立审查。

**Goal:** 按用户补充要求，每一步交付都在轻单内提供能操作、能看到真实结果的入口；先补齐第 1、2 步。

**Architecture:** 在现有画布导航增加 Agent 验证面板。规则编辑复用 shared/agent 校验与排序，浏览器按用户、画布保存验证草稿，可从当前清单复制任务。第 2 步通过仅监听 127.0.0.1 的本机开发入口代理现有轻单，并提供受同源限制的本机 API；复用已验收的 CodexAdapter 与 smoke 脚本，固定测试目录，不从网页接收命令或目录。

**Tech Stack:** 现有 React、Node 24、node:http、ws、Codex app-server。

**Spec:** 用户 2026-11-03 补充：“每一个步骤做完都需要在清单上有功能供我体验验证”。原设计 docs/superpowers/specs/2026-11-03-qingdan-router-design.md。

## Global Constraints

- 每步完成 = 功能实现 + 轻单内入口 + 用户可重复操作的体验步骤 + 自动/真实验证记录。
- 第 9 步负责整合与完善界面，不再作为前面功能首次提供界面的时间点。
- 第 1 步仅规则验证草稿；正式清单规格、顺序写回仍按第 5 步通过 CanvasRoom 完成。
- 第 2 步本机入口仅回环地址、严格 Host/Origin/自定义请求头校验；不暴露任意 cwd、shell 或账号凭据。
- 测试在固定临时根目录下生成 UUID 子目录。请求身份持久化；重复点击、刷新和响应丢失不得重复派发。
- 云端部署仍遵守 AGENTS.md，由用户手工操作；第 3 步完成远程配对。

## Review Focus

- 跨站页面、伪造 Host、缺少同源请求标记不能读项目或启动任务。
- 浏览器重开、请求重试、服务重启不能悄悄多开测试；未知结果先核对。
- 缺少完成条件、环形依赖和手工逆序必须显示具体任务提示。
- 规则草稿切换画布/用户不能串数据，清单正文更新后不能假装草稿已同步。
- 没有本机服务时显示可执行的启动说明，不能展示模拟成功。

## Tasks

- [x] 新增 tests/agent-experience-ui.test.mjs 与 tests/agent-experience-server.test.mjs；先验证失败。
- [x] 新增 src/agent/RuleTrial.jsx、CodexTrial.jsx、AgentExperience.jsx、experience-model.js、experience.css；接入 CanvasWorkspace。
- [x] 新增 scripts/lib/agent-experience-service.mjs、agent-experience-server.mjs 与 scripts/dev-agent.mjs；复用现有 smoke 进程和 Runner，提供状态、项目、会话、启动与核对。
- [x] 13 项体验专项、516/516 全量测试、根/Runner 类型检查和 deploy:check 通过；浏览器验证规则错误/排序、真实清单复制、三会话运行和历史读取。
- [x] 独立审查及复查完成；已知终态失败阻塞新测试、启动中退出、历史读取残留 loading 均通过先失败再修复的回归测试。README 和每步界面验收标准已更新。

## Decisions

- Ruling: 直接补齐已授权的功能入口，不增加一轮方案确认；用户要求每步可体验已明确。
- Ruling: 使用本机轻单入口代理现有 Worker；网页不直连任意端口或云端 shell。代价是第 3 步完成前需要启动本机版轻单。
- Ruling: 第 1 步草稿保存于当前浏览器，并明确显示保存范围；不提前引入第 5 步的服务端任务规格持久化。
- Verification: 与前端构建同时运行的完整测试曾触发既有协作 WebSocket 超时；未改测试或服务端代码。停止构建后单独运行集成测试 16/16、完整测试 516/516 均通过。后续完整回归和构建顺序执行，避免开发服务的资源监听相互影响。
