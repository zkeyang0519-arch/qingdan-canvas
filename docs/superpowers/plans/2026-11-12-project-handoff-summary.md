# 项目交接报告 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans in the current feature checkout. 用户已批准交接结构并要求直接修改；实现后一次独立审查。

**Goal:** Terra 按需读取最新项目，生成能让其他开发者接手的完整交接报告，并自动发到轻单聊天。

**Architecture:** 在现有 ProjectSummary 中增加可选 handoff 对象，新启动总结要求交接字段；旧报告和在途旧运行保持兼容。共用一个六部分报告模型，供摘要页、聊天文本及后续执行上下文使用，入口文件沿用实际读取来源校验。

**Tech Stack:** React / TypeScript / Node.js 24 / Codex app-server / Cloudflare Workers。

**Spec:** 本聊天用户已批准的六部分结构：项目目标与状态、已完成/未完成、最近完成、当前停点、修改入口、接手顺序与验证；取消 350 字限制，保留按需只读与自动聊天投递。

## Global Constraints

- 仅修改 D:/TODO/qingdan-canvas；当前功能分支的既有未提交修改保留，任务基线在 .tmp/handoff-summary-baseline。依赖前轮工作，原地修改，不提交或远端部署。
- 保持 Terra medium、只读和按需读取，不要求读完历史/全部文件。当前代码优先，近期会话补充最新要求，未检查内容明确标注。
- 完整报告不受 350 字限制；保持现有结构化报告 24000 字符传输上限，不重复拼接各部分。
- 修改入口必须为实际已读取的项目内相对文件路径；未确认的目标、测试和部署不冒充完成。
- 保留流式读取、自动聊天投递、同版本去重、草稿及旧报告/运行恢复。

## Review Focus

- 新字段穿过校验、持久化、聊天和执行上下文时不丢失；测试覆盖完整序列化及后续上下文。
- 入口文件不能用未读路径、绝对路径、路径穿越或 native 标记冒充；测试来源边界。
- 无资料时如实显示未确认，不能因空列表声称全部完成；测试空报告。
- 长报告保留末尾验收内容，无 350 字截断或重复主体；测试长文本与六部分顺序。
- 新总结完成后聊天自动接收且无重复；旧报告显示和已有 current 模式仍兼容。

## Tasks

- [x] 1. 定义 ProjectHandoff（technicalOverview/recentChanges/currentFocus/entryPoints/nextSteps/constraints），拓展 schema、来源校验和新启动报告要求；新增失败测试再实现。入口 nextSteps 含优先级与验收，未完成与状态沿用模块。修改 shared/agent/{contracts,schemas,progress}.ts、runner/{prompt,types,codex-adapter,project-inspection}.ts 及相关 runner fixture/tests。
- [x] 2. 六部分统一输出：shared/agent/handoff.ts 生成正文区块，worker 聊天投递使用完整文本，摘要页按区块展示，后续任务上下文包含交接；旧版布局保留。新增文本、UI、投递去重测试。修改 ProjectSummaryPanel.jsx、project-summary-message.ts、prompt.ts 和 docs/agent-experience.md。
- [x] 3. 定向测试、全量 npm test -- --test-concurrency=4、npm run check、npm run runner:build、npm run deploy:check；独立审查；真实 Terra 隔离验收和浏览器检查，安全更新本机服务。

## Execution Ledger

- Pre-flight: Task 1 的可选 handoff 通过现有 summary DTO 存储，Task 2 消费同一字段；旧报告无需迁移。新运行持久化 reportFormat=handoff，旧 current 运行不强制补齐不存在的旧工具字段。
- Ruling: 用户已明确批准结构并直接要求执行；延续既有 feature checkout，保留基线，不另建缺少未提交依赖的工作树。

- Task 1/2: 新报告 schema、六部分 UI/聊天文本、入口来源、长正文与下一任务上下文测试 RED→GREEN。定向测试发现 project_current 未进入自动聊天发布条件，真实 Durable Object 集成测试 RED→GREEN 修复，刷新去重保持。
- Review: 独立审查确认 2 项 Important，无 Critical/Minor，Declined to judge=[]。混合新旧字段会丢内容：追加独有旧列表至进度正文，回归 RED→GREEN。旧 current 提示与旧工具不一致：按 reportFormat 分流 legacy_current 提示及 schema，恢复回归 RED→GREEN。
- First full suite: 1305/1305 通过（271.9 秒）。审查修复后重新执行全套；新交接 8/8、启动与旧运行兼容 3/3 已通过。
- Real Terra: .tmp/handoff-summary-live-o7vfiI/verification.json，Terra medium，64 文件中只读 4 个，29.0 秒完成，准确识别 CSV 占位和旧计划冲突，提供实际入口与验收步骤，项目哈希不变。第一次验收脚本仅匹配 remaining 文本漏掉模块标题中的 CSV，修正脚本后完整验收通过。
- Browser: 用真实 Terra 报告在正式 ProjectSummaryCard 和 ChatPanel 组件中检查，六部分完整显示，修改入口与末尾验收均保留；长路径换行和区块间距可读。

- Final verification: 最终全套 1305/1306 通过（195.3 秒）；唯一失败是既有 source launcher 崩溃后等待端口释放超时（agent-launcher-process.test.mjs:116）。未修改启动器代码，单独重跑该完整测试文件 3/3 通过（22.1 秒）。前一全套 1305/1305 通过，新增混合字段与旧提示回归均通过。npm run check、runner:build（含 runner:check）、deploy:check 和 git diff --check 均完成，deploy 仅 dry-run。
- Local activation: 安全 agent:restart 成功，PID 14764，ready=true，web=running，活跃执行0。刷新实际轻单页面后 surge（我）登录保留、电脑在线。旧摘要未改写；下一次重新总结使用交接格式。临时验收浏览器与预览服务已关闭，未部署远端。
