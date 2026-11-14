# 摘要提速与进度显示

用户已明确要求等待当前总结结束后直接实施四项修改。本机运行 4f6b68f6-7f58-48cd-be15-f3372633c28f 于 2026-11-12 08:51:41 UTC 完成，445 条记录、91 页、12 个模块，terminal=true、active=false、resultValid=true。

## 设计与约束

- 新摘要固定使用 gpt-6.1-terra / medium，设置随运行持久化；普通开发任务及旧摘要续跑保留各自设置。
- 保留 10000 字节的安全分页、来源校验、末页回执、停止及恢复保护。通常只传 cursor，每 5 页或主题切换才保存一次不超过 1800 字符的累计要点。旧运行仍可接受原来的 6000 字符笔记。
- 以已成功完成的同账号、绑定版本、工作区、目录、记忆代次摘要作为缓存。逐条比较脱敏历史指纹；未变化记录用上次结构化报告代替原文，新增记录仍完整分页。任何既有记录（含状态记录）变化/删除、读取失败或缓存不合格时全量重建，避免缺少逐条来源的背景或事实被错误筛除/保留。缓存是历史事实，不是当前代码验收。
- 缓存报告也走有界分页，不塞回初始上下文；原生统计分别显示复用数量和新读取数量。最新更正覆盖旧事实，新增历史证据和来源不得丢失。缓存保存在已有 Runner SQLite 运行记录中，重启仍可用。
- 进度由 Runner 生成，通过已有原生状态报告传到 Worker 和页面；区分采集、读取缓存、读取历史、整理报告。显示读取条数/总数、复用条数、页数、用时和最近进度时间，100% 读取不等于报告完成。
- 当前有其他已授权的未提交工作，使用 .tmp/summary-speed-baseline 逐文件基线原地修改，不提交/覆盖其他改动，不部署线上。完成检查且本机空闲后更新服务。

## 实施步骤

- [x] 1. 写缓存、模型与笔记回归测试，观察失败，再实现 selectHistoryCache/historyReadInput 与新摘要设置。覆盖权限隔离、内容改写/删除、状态更新、失败缓存、无变化和重启；所有缓存内容仍须读取完并提交正确末页回执。
  Files: runner/summary-cache.ts, runner/project-history.ts, runner/project-history-pages.ts, runner/codex-adapter.ts, runner/prompt.ts, runner/types.ts, tests/summary-cache.test.mjs, tests/runner-codex.test.mjs, tests/runner-project-history.test.mjs.
  Verify: node --test tests/summary-cache.test.mjs tests/runner-project-history.test.mjs tests/runner-codex.test.mjs → PASS.
- [x] 2. 写原生进度传输、持久化、UI 回归测试，观察失败，再实现 SummaryReadProgress、原生报告字段、Worker 折叠和页面进度。拒绝越界计数、错项目和旧报告覆盖，终态显示优先于读取进度。
  Files: shared/agent/{contracts,schemas,execution,project}.ts, runner/{summary-progress,codex-adapter,executor,types}.ts, worker/execution/{dispatch,project-summary}.ts, src/agent/{ProjectSummaryPanel,SummaryReadProgress}.jsx, tests/{runner-execution,agent-project-durable,agent-summary-read-progress}.test.mjs.
  Verify: node --test tests/runner-execution.test.mjs tests/agent-project-durable.test.mjs tests/agent-summary-read-progress.test.mjs → PASS.
- [ ] 3. 更新覆盖文案和文档；隔离真实 Terra 测试首轮与增量轮，核对实际模型/effort、末尾更正、缓存复用和耗时；独立审查本次 diff，修复重要发现。
- [ ] 4. npm test -- --test-concurrency=4、npm run check、npm run runner:check、npm run deploy:check、npm run runner:build 均通过。检查无活跃任务，再更新本机服务并核对运行健康。

## Review Focus

- 不同账号、绑定版本、目录或记忆代次不能共享缓存；失败/取消/未读完的结果不能成为缓存。
- 旧结论的证据变更或消失不会被静默沿用；状态更正不能变成功能完成证据。
- 缓存正文仍有界分页，未交付缓存和新记录不能通过末页校验；重试/断线不重复推进计数。
- 进度报告沿用原生授权、版本和命令保护；旧状态、取消和重启不污染新运行。
- 页面区分读取结束与报告完成，不将记录百分比说成项目完成率；新模型只作用于新摘要。

## 执行记录

- 已确认原摘要成功完成后才开始修改；已保存逐文件基线。
- 文档方案与执行方式按用户本轮明确指令执行，不另行申请重复确认。
- Task 1: 缓存 7 项及模型/RPC 2 项 RED→GREEN；初版状态局部剔除策略已由下述审查修复替代。
- Task 2: UI/schema 5 项、真实 DO 重启/旧报告 1 项、Runner 原生报告转发 1 项 RED→GREEN。进度使用已有带版本的原生报告，而非模型文本。
- 定向回归通过 136/136；npm run check 与 npm run runner:check 通过。
- 隔离真实 Terra 验收 .tmp/summary-speed-live-CftDsx/verification.json：首轮 4 页 18.8 秒；新增一条“撤销已完成、CSV 优先”的更正后，增量轮复用旧记录、仅读 1 页，15.4 秒，正确更新模块。两轮实际模型均 gpt-6.1-terra / medium，隔离项目文件未变。此为小规模验收，不代表用户全部 445 条的耗时。
- 真实项目只读分页检查 .tmp/summary-speed-corpus-result.json：当前 450 条，复用已完成报告的 445 条，仅 5 条新增；包含缓存报告的输入共 5 页，全量需要 92 页。未运行新的用户项目总结。
- Final review: 两个 Important：变化状态的局部剔除会丢失无逐条来源的有效事实，或留下来源已删除的项目背景。两项分别以 aggregate/missing provenance 与 deleted-status background 测试复现 RED→GREEN；缓存测试 9/9 通过，无 Minor。
- Ruling: 任何既有记录内容变化/删除（含状态）均全量重建，不猜测事实级依赖；新增记录仍增量。代价是进行中记录被改写时本轮会较慢，换取不丢事实、不沿用过期背景。
