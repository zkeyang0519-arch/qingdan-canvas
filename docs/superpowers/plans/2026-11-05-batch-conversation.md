# 一次提交一个 Codex 会话

目标：用户一次提交的有序待办形成一个执行批次；批次只创建一次 Codex thread，每项待办分别在同一 thread 的下一轮执行。不同提交新建 thread。暂不处理桌面侧栏归组。

接口：继续使用 kind=task 的不可变 ExecutionSnapshot，可附 batch.items（1–50 个 taskId/text/instruction/acceptance 项）；原 task 为首项完整 TaskSpec。手动意图支持 items 数组，与单条 instruction 互斥。一次 intent/create_run 创建一个 runId。

运行：Runner 持久保存 batch 进度和 running/ready/paused/complete/cancelled 阶段，当前项只在有效 done 回执且本轮已结束时进入 ready。下一轮由 Executor 在重新核对租约、授权并优先处理停止命令后启动。中间轮不释放批次锁，不重建 thread；不确定启动先查原 clientUserMessageId，禁止重发。批次遇到失败、无效回执、输入/审批或用户停止时不启动后续项。暂停后的补充继续当前项。

UI：有序待办编辑、增加/删除/移动，一次提交整批；列表显示当前项和每项结果。原单条派单/总结保留兼容。完成后的正式清单自动写回仍属后续工作。

- [x] 共享契约与 Worker 意图、进度校验及回归。
- [x] Runner 单会话顺序推进、恢复、失败/停止边界及回归。
- [x] 批次编辑与进度 UI、交互回归。
- [x] 完整回归、类型检查、打包检查。
- [x] 三待办真实验收：依赖前项结果的三个文件步骤，确认顺序、三个 turn、同一 thread；下一次提交确认新 thread。

完成记录：634/634 全量测试通过。真实三项批次 thread 为 `01a1a78a-f2ef-7370-996f-40631ad0c9e6`，新提交 thread 为 `01a1a791-029c-7722-9eae-0d2c9c31eda5`；详见 `docs/agent-batch-verification-2026-11-05.md`。复核补齐了 uncertain 回执的可靠恢复、两项之间取消的独立持久化事件、取消后的进度一致性，并限制每轮上下文只含当前项。

职责：review_single_task 负责 shared/Worker；review_desktop_refresh 负责 UI；主代理负责 Runner、整合与本机实测。保留此前已有未提交修改；不开启任何侧栏刷新尝试。
