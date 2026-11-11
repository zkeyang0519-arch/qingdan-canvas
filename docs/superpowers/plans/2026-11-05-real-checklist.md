# 第五步：真实清单与批次结果回写

目标：真实清单待办持久保存执行要求、顺序；选择未完成项一次提交为同会话批次；按用户选择在有效执行完成回执后自动勾选原待办。

真实数据继续由 CanvasRoom 的对象版本、事务、幂等回执和广播维护。执行规格放在房间侧表，按 noteId/taskId 关联；在所有 commitChanges 路径维护待办语义代数，正文、备注、完成/重新打开、删除/恢复会改变代数，布局和无关项不会。不可变执行快照绑定真实 TaskRef、generation、specRevision。

本轮用户要求执行完成后更新清单；界面明确提供“执行成功且待办未变化时自动勾选完成”。该选项以当前有效轮次的 done 执行回执为依据，不伪称已有独立的人类审批或全套验收器。测试另实际核对文件结果。未勾选此项则保持清单原状态。

回写由 Worker 接受的新报告驱动，使用持久 outbox 与 CanvasRoom 的稳定去重键。只设置匹配的原任务 done/completedAt，不覆盖其他字段。删除、锁定、移组或代数/规格不匹配时留待核对；失败、取消以及过时报告不新增回写。回执丢失只重试写回，不重跑 Codex。

UI增加第5步真实清单入口，按实际顶层frame/ungrouped及其本机绑定操作。增加、编辑、排序走服务器真实清单命令，不复制到localStorage。派单仍一次提交一会话；侧栏归组保持不处理。

- [x] CanvasRoom 规格、语义版本、真实增改排序、快照与幂等完成事务。
- [x] 真实来源契约、Runner completedTurnId、已封存完成项保护。
- [x] Worker来源快照、回写outbox/重试/状态展示与授权校验。
- [x] 第5步UI、真实保存/排序/选择派单/完成状态展示。
- [x] 完整测试、类型与打包检查。
- [x] 创建几个真实待办，验证排序持久化、同会话批次执行、原清单自动勾选以及刷新后保持。

实测：在“第五步真实清单测试”真实frame中新建3项，先按3/1/2插入，保存缺失执行规格，再重排为1/2/3。一个run、一个thread、3轮按序完成；原note三项done=true，arrangedOrder为0/1/2，服务重启后仍保留。整合回归667/667通过，最后写前授权复核另7项通过。详见 `docs/agent-checklist-verification-2026-11-05.md`。

职责：review_single_task负责CanvasRoom；review_desktop_refresh负责UI；review_batch_final负责shared/Runner来源；主代理负责Worker执行桥、outbox、整合与真实验收。
