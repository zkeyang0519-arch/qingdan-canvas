# 当前项目按需总结与流式输出 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans in this session. 用户已明确批准直接修改，完成后进行一次独立审查。

**Goal:** Codex 使用 Terra medium 按需读取当前项目最新情况，直接返回进度报告；轻单摘要页实时展示实际读取动作和助手输出。

**Architecture:** 新摘要启用 current 模式，在同一只读会话中提供项目检查和可选的最近历史查询工具。取消新摘要的全量历史预采集、缓存归并和末页回执要求；已有历史模式运行继续恢复。通过既有有序 output.delta 事件向摘要页增量交付读取日志和公开助手文字，最终结构化报告沿用原有校验与自动聊天投递。

**Tech Stack:** TypeScript / Node.js 24 / Codex app-server / Cloudflare Workers / React。

**Spec:** 本聊天用户批准的方案及新增 Terra、摘要界面读取流式输出要求（2026-11-12）。

## Global Constraints

- 范围始终为当前绑定项目；按需读取，不强制遍历所有目录或历史。最新代码优先，近期会话补充目标及未落地事项。
- 保留只读、授权、停止、恢复、来源验证、旧运行兼容及自动投递；不修改用户项目或执行开发待办。
- 新摘要使用 gpt-6.1-terra / medium；普通任务模型不变。
- 当前 feat/qingdan-mcp 上有既有未提交工作，本次依赖它们；原地修改，基线存于 .tmp/current-summary-baseline。不提交其他工作、不部署线上。
- 流式展示真实读取动作与公开助手输出，不展示内部推理或原始凭据；输出有界、支持断线补读和切换项目隔离。

## Review Focus

- 无历史或旧记录很多时，新摘要能直接检查项目并提交，不因未读完而失败。
- 最近历史查询防止跨项目、来源不明分叉或摘要自引用；读取可停止，失败不伪造覆盖。
- 新旧总结续跑分别使用原有工具和校验；停止后不返回新内容。
- 摘要流增量不重复，切换项目/运行不串数据，网络错误可恢复，结束前排空已收到事件。
- 实际读取阶段没有虚假总数或百分比，最终报告正确进入摘要页和聊天。

## Tasks

- [x] 1. Runner 按需读取：新增 current 模式、最近历史工具、实际读取事件；先增加启动无全量历史/部分读取可提交/越界拒绝测试，再实现。文件 runner/{codex-adapter,prompt,types,project-inspection,summary-progress,project-recent-history}.ts、shared/agent/{contracts,summary-progress}.ts；tests/runner-codex.test.mjs、tests/fixtures/fake-codex.mjs、tests/runner-project-recent-history.test.mjs。旧历史测试改为恢复原模式的兼容回归。
- [x] 2. 摘要页增量输出：复用 codex_get_run 的 afterSeq 分页读取，显示实时日志、错误重连和截断状态；按绑定及运行隔离。文件 src/agent/{ProjectSummaryPanel,SummaryReadProgress,SummaryLiveOutput}.jsx、src/agent/agent.css；tests/agent-summary-live-output.test.mjs、tests/agent-summary-read-progress.test.mjs。
- [x] 3. 完整验证与本机生效：定向测试、npm test -- --test-concurrency=4、npm run check、npm run runner:check、npm run deploy:check、npm run runner:build；独立审查和隔离真实 Terra 验收、浏览器检查。确认本机无活跃执行后更新服务，核对账号与设备在线。

## Execution Ledger

- Pre-flight: Task 1 emits existing output.delta events and mode=project progress consumed by Task 2; result delivery retains existing ProjectSummary modules contract.
- Baseline: another summary chat is idle/interrupted; existing edits preserved in .tmp/current-summary-baseline. No overlapping active edit observed.
- Ruling: use the existing feature checkout because the requested change depends on uncommitted summary, project picker and delivery work; baseline records isolate this task's diff. No user changes are reverted or committed.

- Task 1: 新摘要未采集历史即可启动、部分长文件读取后提交、浅层目录浏览、来源与最近历史边界测试 RED→GREEN；旧分页与缓存通过原模式续跑回归保留。
- Task 2: 增量输出、重复块、项目切换隔离、网络重连及无总数进度测试 RED→GREEN；真实浏览器检查了读取日志与完整模块报告布局。
- Live verification: .tmp/current-summary-live-bF982O/verification.json；实际 Terra medium，64 文件中读取 3 个，18.67 秒完成；原生首个公开输出在 8.525 秒，185 条输出事件；正确识别 CSV 未实现，项目文件哈希不变。
- Final review: 一项 Important——摘要状态先到会提前停止流补读——已由延迟终态事件测试 RED→GREEN 修复，按当前 turnId 的结束事件确认后才结束输出。无其他 Critical/Important、无 Declined to judge。
- Final: Ruling: 将准备阶段错误标为历史采集的发现提升为必须修复的来源状态问题；新模式从启动即标为项目读取，避免等待期间误报正在全量读历史。启动前 guard 断言 RED→GREEN，旧运行仍使用旧进度。
- Full-suite first pass: 1294/1295；唯一失败为 queued read-only summary 的旧历史模式断言，已按新的检查模式更新并单独通过，最终全套结果见下。

- Final verification: npm test -- --test-concurrency=4 passed 1297/1297 (178.6 s); npm run check, npm run runner:build (含 runner:check), npm run deploy:check 全通过，后者仅 dry-run。无未处理审查项。原生模型验证与独立浏览器回放完成。
- Local activation: npm run agent:restart 成功；无活跃执行，服务 ready=true、web=running，8790/8788 在线。Edge 刷新后原账号 surge（我）与电脑在线状态保留，项目摘要抽屉已显示「Codex 读取与输出」及既有报告。未触发新的用户摘要，未部署远端。
