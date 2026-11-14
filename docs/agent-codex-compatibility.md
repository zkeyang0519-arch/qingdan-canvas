# 第 2 步：本机 Codex 适配与验证

首次验收为 2026-11-03，当前兼容版本更新于 2026-11-13。对应 [实施计划 Task 2](superpowers/plans/2026-11-03-qingdan-router.md)。本步骤已经提供独立本地适配器，可读取 Codex 会话、新建总结和任务会话、发送要求、接收结构化结果、继续同一任务、取消及核实中断状态。

## 已验证的本机环境

轻单已提供「Agent 验证 → 2 · 本机 Codex」入口。运行 `npm run dev:agent` 后可在 <http://127.0.0.1:8790> 检查连接、读取项目和会话、发起三会话测试并查看输出，详见 [体验步骤](agent-experience.md)。

| 项目      | 结果                                                                   |
| --------- | ---------------------------------------------------------------------- |
| 操作系统  | Windows，用户交互登录账号                                              |
| Node.js   | 24.18.0；Runner 要求 Node.js 24 或以上                                 |
| Codex CLI | **0.167.0-alpha.4.1**，与 `runner/protocol-version.json` 一致          |
| 登录      | 使用本机已登录的 ChatGPT 账号，不需要新增 API key                      |
| 连接      | Runner 自行创建 app-server stdio 子进程，JSONL / JSON-RPC              |
| 协议类型  | 由固定版本生成并保留所用类型的依赖，共 183 个声明文件                  |
| 总结权限  | read-only，on-request 审批                                             |
| 任务权限  | workspace-write，仅指定工作目录可写，网络执行权限关闭，on-request 审批 |
| 模型      | 沿用本机配置；本次简单 smoke 显式使用 low 推理强度，未替换模型         |

隔离的 `CodexSandboxOffline` 账号查询时显示未登录；使用真实 Windows 用户启动后，`codex login status` 与 `account/read` 均确认已经登录。运行程序须使用该用户身份，不能通过复制认证文件解决账号隔离问题。

协议字段通过本机生成的类型检查。流程参考 [OpenAI 官方 app-server 文档](https://learn.chatgpt.com/docs/app-server)：初始化、线程、轮次、通知、历史分页和审批请求。版本不匹配时适配器在创建 app-server 前明确拒绝执行，不自动升级或静默改用其他接口。

## 2026-11-06：Codex 更新后的会话入口

实测发现原安装记录指向已删除的 WindowsApps alpha.6 程序。固定版本更新为实际已安装的 `0.167.0-alpha.3.2`，通过该程序重新生成 143 个声明；语义变化仅为可选 `requiredHumanApproval` 能力，以及输入音频增加 fileId 形态。当前线程、轮次及历史查询字段保持兼容，未知版本仍拒绝执行。

真实只读查询返回首批 50 条会话与后续游标；按会话 ID 重新读取的工作目录匹配。正式 Agent 新增无需预登记目录的会话选择入口，选中后自动关联项目，每次提交依旧新建会话。此次接入检查未调用模型或发送任何旧会话消息。安装记录已通过原安装命令刷新，既有身份和数据保留。完整验证见 [会话入口验证](agent-session-entry-verification-2026-11-06.md)。

## 2026-11-04：Codex alpha.6 兼容修复

用户实际安装的 Codex 已更新为 `0.166.0-alpha.6`，而轻单仍固定在 `0.166.0-alpha.5.1`，导致连接前的版本检查拒绝启动。先将假 Codex 的报告版本改为 alpha.6，现有三会话集成测试复现同一 `CODEX_VERSION_MISMATCH`；随后更新固定版本，并用当前真实二进制重新生成协议。

143 个生成的声明文件仅版本来源注释发生变化，字段与旧版完全一致；未放宽未知版本检查、审批策略或目录授权，也未修改用户 Codex 配置。

验证结果：

- 本机适配器和执行消费者专项 45/45 通过，包含不支持版本仍在启动前拒绝的检查。
- 完整回归 583/583 通过；Worker/Runner 类型检查、Runner 构建和部署 dry run 通过，未部署生产。
- 当前 Windows 用户的真实 app-server 握手、`account/read`、项目会话查询通过，报告 `codex-cli 0.166.0-alpha.6`、authenticated=true。
- 在轻单第 4 步通过 MCP 提交单独的文件任务。运行 `9b176a47-1fbd-4746-82cf-5c2e65209526`，会话 `01a1a576-df23-7522-88ad-79b8ac614f05`，轮次 `01a1a576-f411-7a31-92c5-9901dc283b79` 已结束，状态 verifying、结果 done。
- 本机读取 `D:\TODO\qingdan-canvas\.tmp\execution-trial\1d70cd93dd84791ab0868eab\codex-alpha6-check.txt`，内容严格为 `Codex alpha.6 连接正常。`，无额外换行；原 `hello.txt` 内容、设备及测试关联保持不变。
- 原浏览器页面恢复同步、版本错误消失；保留用户已经填写的执行要求和完成标准。验证在独立临时标签页完成，随后关闭该页并返回原入口。

本地证据：`.tmp/codex-alpha6-verification.json`、`.tmp/codex-alpha6-capabilities.runner/report.json`、`.tmp/codex-alpha6-tests.log`、`.tmp/codex-alpha6-deploy.log` 和 `.tmp/codex-alpha6-fixed.png`。未来切换到其他 Codex 版本时，仍需要重新生成协议并完成兼容验证。

## 真实三会话验收（2026-11-03，alpha.5.1）

测试目录：`D:\TODO\qingdan-canvas\.tmp\codex-smoke-20261103-step2`。该目录是新建的独立 Git 项目，只包含测试说明和两个验证产物。会话和结果使用唯一运行 ID；本地 SQLite 与运行快照放在同级 `.runner` 临时目录。

| 运行     | Codex threadId                         | 验收                                                                            |
| -------- | -------------------------------------- | ------------------------------------------------------------------------------- |
| 项目总结 | `01a1a112-11fc-7f22-b877-7fd3fb212cef` | 只读检查 README、AGENTS 与 Git，返回有效 ProjectSummary；历史轮次为 completed。 |
| 任务 A   | `01a1a112-7d6b-7232-a859-5d047bdd84f4` | 读取随机 fixtureToken，创建 task-a.txt；宿主逐字检查内容和换行。                |
| 任务 B   | `01a1a112-decd-7071-9c3e-03b7f9bf7a0d` | 在新会话读取 A 的产物，创建 task-b.txt；宿主检查内容和换行。                    |

三者 threadId 不同、cwd 相同，三个持久化轮次均为 completed。三个 ID 都已通过 Codex 桌面历史列表查询确认可见；没有调用桌面内部创建会话工具完成产品接入，也没有验证侧边栏原生项目分组的具体呈现。

原始本地结果保存在 `.tmp/codex-smoke-20261103-step2.runner/report-first-run.json`。可共享的验收摘要见 [验收证据](agent-codex-smoke-2026-11-03.json)，其中不含登录凭据或用户历史聊天内容。

## 开发和复验

```powershell
cd D:\TODO\qingdan-canvas
npm ci
npm ci --prefix runner
npm run runner:build
npm run test:runner
```

在已登录 Codex 的 Windows 用户终端中进行只读能力检查：

```powershell
node scripts/agent-codex-smoke.mjs --workspace D:\TODO\qingdan-canvas\.tmp\my-codex-smoke --mode capabilities
```

真实三会话验证会调用 Codex 并创建两个测试文件：

```powershell
node scripts/agent-codex-smoke.mjs --workspace D:\TODO\qingdan-canvas\.tmp\my-codex-smoke --mode new-threads
```

新 smoke 仅接受空目录；已有 smoke 必须保留同级 `.runner` 中的快照与运行记录。重复调用沿用原 runId，读取或核实已有会话，不重复提交执行。仍无法核实的启动停在 reconciliation_required；脚本不会把再次运行命令当作重新执行的许可。单次任务默认等候最多 5 分钟，可用 `--timeout-ms` 调整；遇到输入或审批请求会明确停止测试等待，不自动同意。

可设置 `QINGDAN_CODEX_BIN` 指向已验证的 Codex 可执行文件。修改版本固定值前，需要使用目标版本重新运行 `npm run runner:protocol`、类型检查、故障测试和真实验收。该脚本只生成当前需要的声明文件；不直接修改用户的 Codex 配置。

## 公共接口

2026-11-04 可读性更新：用户消息改为自然语言任务/完成标准/必要背景，执行快照仍保存在 Runner。模型结果不再要求生成 runId/taskId，由适配器补全可信身份；旧结果带身份时仍严格核对。历史恢复使用协议中的 clientUserMessageId/clientId，未改为根据提示词猜测。详见 [项目命名与派单验收](agent-readable-dispatch-verification-2026-11-04.md)。

从 `runner/dist/index.js` 导入 `CodexAdapter`、`RunnerStore`、`readGitBaseline`。构造时由可信本地调用方提供 workspaceId 与允许目录的对应关系，快照本身不能指定 cwd。

| 接口                                   | 行为                                                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `connect()` / `account()`              | 固定版本检查、initialize/initialized 握手与登录状态查询。                                            |
| `listProjects()`                       | 对已登记目录分页读取 cli、vscode、exec、appServer 来源的会话元数据。                                 |
| `readThread(threadId, workspaceId)`    | 核对目录归属，读取元数据与完整分页历史。                                                             |
| `startFreshRun(snapshot)`              | 首次运行新建线程，持久化 threadId 后发送 turn/start；重复 runId 校验快照并返回原回执或恢复已有运行。 |
| `continueRun(input)`                   | 空闲时在原线程回复；运行中通过 steer 与 expectedTurnId 补充要求。同一 requestId 不重复发送。         |
| `cancelRun(runId)`                     | 发出中断请求；轮次及后台进程确认停止前保持未确认状态。                                               |
| `reconcileRun(runId)`                  | 分页查询已知线程，以持久化 turnId 或 clientUserMessageId 匹配；不会重新执行任务。                    |
| `pendingRequests` / `respondToRequest` | 暴露并答复当前轮次的命令/文件审批和工具输入。支持单次同意、拒绝、取消；未知请求不自动批准。          |
| `events()` / `waitForRun()`            | 读取持久化事件和运行结果。结果有效时进入 verifying，真实业务验收仍由后续队列完成。                   |
| `close()`                              | 中断本适配器管理的运行，核实停止状态，关闭自己创建的子进程；不能确认时保留待核实记录。               |

目录互斥目前由本地 SQLite 中活动运行的唯一索引保护。设备安装、配对、跨 Runner 实例目录锁和租约在第 3 步实现。快照 Git 基线比较 HEAD、分支和是否有未提交改动；不会 reset、clean 或 stash 用户文件。完整业务授权、规格哈希与画布版本核对属于第 5/8 步。

## 可靠性验证

故障测试使用真实子进程 JSONL 通信和独立 SQLite，覆盖：

- 三任务新线程、同任务继续原线程、threadId 先持久化再开始轮次。
- 同 runId / requestId 重放、相同 ID 不同参数拒绝、未知 turnId 的完成通知不推进状态。
- thread/start 和 turn/start 响应丢失、进程退出、历史分页和消息分页恢复；不确定时不自动重发。
- 完成通知重复、先于启动响应、与历史请求同时到达，以及历史随后报错；终态不会被覆盖。
- 恢复订阅失败后再次尝试，不把失败的订阅标为成功。
- 审批和问题在显式回复前等待，对账不会清除等待状态。
- 取消意图独立持久化；仅对当前任务线程的后台终端分页终止，再确认列表为空。无法确认时不宣称已取消，并保留目录占用。
- 输出不合法不当作成功，SQLite 重开保留记录，未知数据库版本和不匹配的 Codex 版本明确拒绝。

数据库使用 `user_version` 版本迁移和事务；结果事件、运行状态在同一事务保存。调试 stderr 被消费但不会直接写入业务结果，避免把认证诊断泄露到轻单。详细执行材料只在本机临时验证目录中保存。

本步骤的核心接入已由真实 Codex 验证；重启、丢包与进程清理的组合场景由可控 fake-codex 验证。尚未做真实 Codex 进程崩溃、Windows 重启或断网的破坏性测试，这些是第 10 步的稳定性验收范围。

核心适配器验收：**25 项 Runner 专项、503/503 完整回归**通过，根项目与 Runner 类型检查、Runner 构建、部署 dry run 均通过，独立审查问题已关闭。最终构建重放三会话验收记录后，所有 runId/threadId/turnId 与首次运行一致，历史会话数仍为 3。

随后按用户“每步都可在轻单体验”的要求新增了网页入口与本机体验服务：**13 项体验专项、516/516 完整回归**通过，类型检查和部署 dry run 通过。真实浏览器从「Agent 验证」发起了另一组独立的总结/A/B，会话历史读取与结果展示均通过。前端构建仍有原有的主包大于 500 kB 提示，体验面板单独按需加载。详见 [网页体验验收](agent-experience-verification-2026-11-03.json)。
