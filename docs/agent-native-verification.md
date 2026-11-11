# 本机逐项验收

启用受控批次（执行快照 `batch.managed: true`）后，Runner 在每个成功结束的 Codex 轮次之后检查当前待办的验收条件。Codex 的“完成”回执只表示它已结束工作，不能代替本机验收。原生 `verification.completed` 事件绑定实际的 run、thread、turn 和 criterion ID，附文件观察结果的 SHA-256；不会上传被检查文件的内容。

Runner 会等待服务端确认当前项验收及清单写回后，才取得下一轮许可。一个批次保持同一 Codex 会话。最后一项也必须等结束许可，再确认后台终端已停止并释放项目租约。服务端授予许可即视为下一轮已派发；在此之后点击“当前项后暂停”会在这一已派发项结束后暂停。“立即停止”仍会使发送前的权限检查拒绝继续。

## 支持的检查

- `artifact / exists`：路径存在。文件和目录均可；不跟随符号链接或目录联接。
- `artifact / textContains`：读取不超过 1 MiB 的普通 UTF-8 文件并检查指定文字。
- `artifact / jsonSchema`：读取上述大小限制内的 UTF-8 JSON，使用下列严格子集检查。无法解析的 JSON 是验收失败；不支持的 Schema 是待人工处理，绝不忽略约束后判为通过。
- `human`：等待用户在轻单中确认。
- `command`：当前版本没有固定命令、参数和进程树停止证明的本机登记流程。因此返回 `needs_input / unsupported`，不执行命令，也不采用 Codex 自报的执行结果作为通过证据。注册表中的 checkId 和 label 本身不是可执行授权。

JSON Schema 子集支持布尔 Schema、单个 `type`（object、array、string、number、integer、boolean、null）、`enum`、`const`、`properties`、`required`、`additionalProperties`、`items`、`minItems`、`maxItems`、`minimum`、`maximum`、`minLength`、`maxLength`；`title`、`description` 只作注释。`$ref`、正则、组合关键字、类型数组等暂不支持。Schema 深度不超过 12 层、节点不超过 500；数据比较深度不超过 100。

## 失败、恢复与边界

只对实际文件不满足条件（或未来已授权固定命令的非零退出）允许一次同会话自动修复；修复后重新检查当前项全部条件。路径越界、链接、权限、超时、未知检查类型、尚不支持的 Schema 和人工检查均不会自动修复。修复预算和许可 ID 持久化，重启后依据 Codex 实际历史对账，不重复发送未知结果的轮次。

等待验收、暂停和等待服务端许可不计入 30 分钟的实际执行超时；启动下一轮时重新计时。每次继续仍验证原项目目录身份、项目锁、租约以及初始 Git commit/branch。上一项正常产生的工作区 dirty 变化允许继承，分支或 HEAD 改变会阻止继续。

文件验收证据是检查当时的观察结果。轻单不锁定用户或其他本机进程对文件的编辑；文件在验收后的外部修改不属于已经记录的观察结果。
