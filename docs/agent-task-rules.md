# 第 1 步：任务规则、契约与排序

2026-11-03。实现位于 `shared/agent/`，对应 [Router 实施计划的 Task 1](superpowers/plans/2026-11-03-qingdan-router.md)。本步骤提供可调用、可测试的基础规则；真实清单写入在第 5 步，自动执行在第 8 步，网页操作界面在第 9 步接入。

## 一条任务包含什么

| 字段          | 规则                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------- |
| `taskId`      | 计划内唯一 ID；正文相同的两项仍是不同任务。生成时是临时 ID，第 5 步统一映射为服务端 ID。 |
| `text`        | 真实待办正文，非空，最多 32,000 字符。                                                   |
| `instruction` | 补充执行要求，非空，最多 32,000 字符。                                                   |
| `acceptance`  | 1–50 条验收条件，每条有唯一 `id`、说明、是否必需及验收类型。至少一条为必需。             |
| `dependsOn`   | 同一计划中的前置任务 ID；默认空数组。拒绝重复依赖、未知依赖、自依赖及依赖环。            |
| `priority`    | 整数 0–3，0 最紧急，默认 2。                                                             |
| `dueAt`       | 可选截止时间，默认 `null`。输入须带时区，规范化为 UTC ISO 毫秒精度。                     |

每个计划创建 1–50 条任务。超过 50 条整次拒绝，不截断。输入对象使用严格字段校验；模型不能通过附带 `actor`、`ownerId`、`cwd`、任意命令或 `done` 字段获得权限或预先完成待办。

验收类型有三种：

- `command`：只提供已登记检查的 `checkId`，例如 `test`，不接受 shell 命令。执行快照中的检查必须在 `allowedCheckIds` 中。
- `artifact`：指定项目内相对文件路径，条件为存在、JSON Schema 或包含文字。拒绝绝对路径、`..`、Windows 设备名及替代数据流。真实路径、junction 边界与文件内容的检查由后续 Runner 执行。
- `human`：需要人工判断；后续执行器必须等待确认。

“至少一条必需验收”、字段长度上限和默认优先级是本步的实现选择，避免任务在没有有效验收条件时自动通过；这些值集中在 schema 中。JSON Schema 目前作为 JSON 数据传递，实际编译和验证在第 8 步实现。

## 排序如何决定

先检查整个依赖图，再每次从前置任务均已排好的任务中选下一项，依次比较：

1. 用户显式顺序（提供时）。
2. 优先级，从 0 到 3。
3. 截止时间，从早到晚，无日期放最后。
4. 原始输入顺序，最后以任务 ID 作稳定兜底。

依赖始终是硬约束。例如 A 依赖 B，即使 A 更紧急，仍输出 B → A。新解锁的任务立即参与优先级比较，不必等当前同层任务全部排完。

`sortPlan(tasks, explicitOrder?)` 返回任务 ID 数组，不修改输入。显式顺序必须包含每条任务恰好一次；排序器会遵守依赖调整它。`validateManualOrder(tasks, order)` 用于手工拖动后的校验：合法就原样接受，不合法就返回冲突，调用方保留原有顺序。创建空计划不合法，但对空列表排序可返回 `[]`。

循环错误返回一条实际闭环，例如 `{ taskIds: ['A', 'B'], cycle: ['A', 'B', 'A'] }`；依赖这个环的下游任务不会被误报为环成员。有多个环时先报告其中一个，修复后可再次校验。

## 日期

`normalizeAgentDeadline('2026-11-03T10:00:00+08:00')` 返回 `2026-11-03T02:00:00.000Z`，并复用现有 `validDeadline` 检查存储格式。

相对日期先转换为明确的日历偏移与时刻，再调用：

```ts
resolveRelativeDeadline(
  { daysFromNow: 0, time: "09:00", timeZone: "Asia/Shanghai" },
  "2026-11-02T17:00:00.000Z",
); // 2026-11-03T01:00:00.000Z
```

时区默认上海；参考时间 `now` 必须显式提供，让请求重放得到相同日期。不存在的日期、无时区的绝对时间及夏令时跳时/重复时间均拒绝，不借用电脑或 Worker 的本地时区猜测。自然语言“明天”的理解留给聊天层；本模块不直接解释自由文本。

## 后续步骤共用的接口

| 接口                               | 作用                                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------- |
| `parseAgentCommand(unknown)`       | 校验 `create_plan` / `reorder_plan`，创建时一并检查依赖图。其他聊天意图在后续步骤扩展。 |
| `sortPlan` / `validateManualOrder` | 自动排序和手工排序校验。                                                                |
| `parseRunOutcome(unknown)`         | 校验结构化任务结果；`done` 不允许同时携带未解决问题。                                   |
| `parseRunnerEvent(unknown)`        | 按事件类型校验协议、序号、thread/turn 身份及 payload，拒绝将失败/中断轮次伪装为成功。   |
| `parseCommandEnvelope(unknown)`    | 校验版本 1、命令与运行 ID、绑定版本及签发/过期时间先后。                                |
| `parseExecutionSnapshot(unknown)`  | 区分总结与任务快照；总结不携带任务，任务规格须 ready，检查 ID 须已登记。                |

公开解析函数将格式错误统一转换为带 `code`、`details` 的 `AgentValidationError`。Zod schema 可用于后续工具定义；接收创建计划时应调用 `parseAgentCommand`，不能只调用单条 schema 而跳过依赖图检查。

`contracts.ts` 定义 TaskSpec、PlanSnapshot、AgentActor、ProjectBinding、QueueBatch、ExecutionRun、ExecutionSnapshot、MemoryRecord、命令/事件信封和 Runner 映射。运行状态与设备在线状态独立。总结结果和任务结果使用不同类型；解析成功不代表验收通过，也不自动勾选任务。

身份、授权、当前时间是否过期、真实哈希、规格与画布正文是否匹配，必须由后续持有权威数据的服务校验。DTO 中格式正确的 `ownerId` 或 `workspaceId` 本身不授予权限。信封 `payloadHash` 是命令去重摘要，`create_run.payloadHash` 是所引用快照的摘要，两者不要求相等。

## 错误码

| 错误码                                | 处理方式                                               |
| ------------------------------------- | ------------------------------------------------------ |
| `VALIDATION_ERROR` / `LIMIT_EXCEEDED` | 修正字段或拆分计划后重试。                             |
| `DUPLICATE_TASK_ID`                   | 给不同任务分配不同 ID。                                |
| `DEPENDENCY_MISSING`                  | 补齐前置任务或删除错误依赖；详情包含任务和依赖 ID。    |
| `DEPENDENCY_CYCLE`                    | 解除返回闭环中的依赖。                                 |
| `MANUAL_ORDER_INVALID`                | 排序必须完整且不重复。                                 |
| `DEPENDENCY_ORDER`                    | 展示具体 `{ taskId, dependencyId }` 冲突，保留原顺序。 |

同时预留 `REVISION_CONFLICT`、`IDEMPOTENCY_KEY_REUSED`、`ACCESS_DENIED`、`RECONCILIATION_REQUIRED` 供后续存储和执行层使用；本步没有实现这些层的业务逻辑。

## 验证与范围

```powershell
cd D:\TODO\qingdan-canvas
npm run test:agent
npm run check
```

完整项目回归和部署打包：

```powershell
# 受限环境中，避免 Wrangler 的全局日志目录写入被拒绝。
$env:WRANGLER_LOG_PATH = "$PWD\.tmp\wrangler-logs\"
$env:WRANGLER_SEND_METRICS = 'false'
npm test
npm run deploy:check
```

`deploy:check` 是本地 dry run，不发布。测试使用独立临时数据，现有网页与清单存储尚未接入这些规则。

验证记录：初次专项测试因模块缺失失败；实现后专项测试通过。完整回归首次遇到 Wrangler 全局日志目录 EPERM，日志混入 JSON 导致旧集成测试失败；将日志目录指向项目 `.tmp` 后该集成测试通过。独立代码审查发现命令摘要与快照摘要不应强制相等，已先用回归测试复现，再移除该限制。

最终结果：专项 **26/26**、完整项目回归 **478/478**、`npm run check` 和 `npm run deploy:check` 全部通过。部署打包仍提示现有前端主包大于 500 kB；本步未增加前端入口。独立审查无剩余待修复项。未执行真实 Codex、设备绑定、数据库写入接入或上线部署。
