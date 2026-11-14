# 项目主动检查与开发进度摘要 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task in the existing authorized workspace.

**Goal:** Codex 主动检查所选项目，取消新摘要的 16 文件采样限制，按模块总结实际进度及可执行的下一步待办。

**Architecture:** 为总结会话提供项目只读检查工具，由 Codex 自行分页浏览完整目录、搜索正文和分段读取任意项目文本。原生 Runner 记录实际提供的来源，摘要引用继续核对这些记录；既有摘要、结果回执、停止与恢复机制保持兼容。

**Tech Stack:** TypeScript、Node.js 24、Codex app-server dynamic tools、React。

**Spec:** 本会话 2026-11-12 用户要求：让 Codex 自己检查整个项目生成摘要，了解完整开发进度与下一步待办，不再只限制 16 个文件。

## Global Constraints

- 只修改 D:/TODO/qingdan-canvas，保留当前未提交的项目选择与待办改动。
- 新总结沿用 read-only 沙箱及既有审批方式；项目文件内容是分析资料，不能扩大权限。
- 不修改项目文件、不安装依赖、不执行待办；无法证实的运行结果单独列为待核实。
- 分页限制只限制单次响应，不限制项目总文件数或目录深度；排除依赖、构建产物、凭据和链接。
- 测试与真实验收均使用独立状态；不占用或改变用户的设备绑定。
- 按 AGENTS.md 执行 npm test、npm run check、npm run deploy:check，另执行 Runner 编译检查；不部署。

## Design Decisions

- 采用 Codex 自主调用只读检查工具。直接扩大一次性资料包仍会遗漏文件并挤占上下文；旧验收也表明通用 shell 阅读可能进入审批等待。因此使用现有 dynamic tool 通道，逐步读取并保留原生来源记录。
- 工具提供 list/read/search/git，路径始终相对于当前已授权项目。单次输出有界，使用明确的继续游标读取剩余内容。
- 结果沿用现有字段：overview 按模块报告现状与检查覆盖；pending 按优先级列出下一步、依据、依赖和验收要求；uncertainties 记录未检查范围及尚未执行的测试。
- 旧摘要不自动重新运行。用户点击「重新总结」或开始新项目总结后采用新流程。

## Review Focus

- 大于 16 个文件、深层目录以及大于 8KiB 的源码能继续读取。
- 搜索结果和文件正文分页不能丢失尾部，空结果不能假装完成整个项目搜索。
- 绝对路径、路径穿越、链接与敏感文件不能越过项目读取范围。
- 并行读取、停止、重新连接不能丢失来源记录或给旧轮次返回新数据。
- 未读文件引用不能伪装成已核验；历史运行仍按旧资料包验证。

## Tasks

- [x] 1. 新增 runner/project-inspection.ts 与 tests/runner-project-inspection.test.mjs。先验证大项目遍历、正文分页、搜索、来源和路径边界失败，再实现只读工具与来源合并。
- [x] 2. 在 runner/codex-adapter.ts、runner/types.ts、runner/prompt.ts 接入自主检查工具与持久化来源；扩展 fake-codex 与 runner-codex 测试验证真实 RPC 工具回路、结果引用及旧运行兼容。
- [x] 3. 更新项目摘要提示及页面文案，明确按模块检查、生成下一步待办；调整超时预算以容纳主动检查，保留停止能力。更新使用文档。
- [x] 4. 跑相关测试、完整验证以及隔离的真实 Codex 检查（包含采样范围外的未完成实现）；确认摘要可引用新读取文件且不修改项目。

## Execution Notes

- 当前工作区包含用户已经验收的未提交改动；在原工作区继续，避免工作树遗漏这些依赖。不提交或覆盖这些既有改动。
- 独立审查发现并修复：凭据文件和 URL userinfo 脱敏、异步工具回复断线处理、目录变化时的分页遗漏、长路径游标与来源引用、旧摘要恢复时的工具提示兼容。各项都有回归覆盖。
- 真实 Codex 隔离验收：`.tmp/project-inspection-live-s1rT5U/result.json`。浏览并读取 30 个文件，分段读取 65,360 字节的深层源码，识别尾部 Markdown 未实现、历史计划与源码冲突以及测试占位，输出带优先级和验收要求的待办。共记录 37 个来源，无额外审批，检查前后文件哈希一致。
- `npm run check`、`npm run runner:build`、`npm run deploy:check` 已通过。部署命令为 dry-run，没有发布。
- 首次全量测试 1225/1226 通过；已有 `installed HMAC recovery preserves the running launcher instance` 测试在 300ms 启动预算下超时，该文件独立复测 3/3 通过。最终 `npm test -- --test-concurrency=4` 全量 1226/1226 通过（173.6 秒），日志 `.tmp/project-inspection-tests-final.log`。
- 当前目录分页为每次重建目录清单并验证指纹，确保变动后显式要求重扫；大目录的多页检查会增加遍历成本。总运行仍有 30 分钟上限，摘要必须报告未检查范围，不能承诺任意规模项目均已检查完毕。
- 本机更新前确认活跃任务为 0，通过受管 `agent:restart` 加载新版本，服务恢复 ready/running；更新后页面仍为 surge 账号、已同步、电脑在线。未刷新用户页面或改动其项目绑定、待办和编辑内容。

## Follow-up: delayed summary delivery

- 真实项目检查在 2026-11-12 14:16 完成，Runner 的结果有效，服务端随后保存了第 2 版摘要。浏览器却停在旧结果与「总结未取得有效结果」提示。
- 根因：执行终态报告与正文事件通过两个持久化队列回传。终态报告先到时，服务端把尚未收到正文判为 failed，页面随即停止轮询。此前真实 Codex 验收验证了 Runner 输出，未覆盖这个页面接收时序。
- 修复：添加 finalizing 状态，等待正文时继续轮询、保留旧结果、禁止重复启动；只有实际失败或无效的已到达结果才进入失败状态。
- 新回归先复现 failed/finalizing 误判及页面不轮询，再验证延迟事件、旧结果保留、重复回执、明确失败、重启恢复，以及真实 workerd + SQLite DO 的先报告后正文顺序。
- 通过页面「刷新总结状态」恢复用户已经完成的第 2 版摘要，未重新启动 Codex 或改动绑定。
- 独立复核补齐同一运行的新轮结果匹配与「停止等待」退出路径。新轮只更新一次摘要版本；停止等待后迟到结果不复活，已收到有效摘要后的迟到停止不撤销结果。5 个结果投递用例及 UI 轮询用例通过定向复核。
- 最终验证：`npm test -- --test-concurrency=4` 共 1233/1233 通过（182.2 秒，`.tmp/summary-delivery-tests-final.log`）；`npm run check`、`npm run runner:check`、`npm run deploy:check` 通过，未部署。
- 本地开发静态资源索引仍指向旧构建，已在无活跃任务时通过受管重启更新；HTTP 校验新版入口脚本与磁盘构建逐字节一致、类型为 JavaScript。页面重新加载后 surge 账号、已同步和电脑在线均正常，项目绑定仍为 TODO。
