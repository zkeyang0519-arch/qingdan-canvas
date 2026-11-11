# 本机 Agent 安装与故障恢复

此版本把生命周期入口安装在当前 checkout 的 `.tmp/agent-install` 中。它依赖这个 checkout 和已安装的依赖，不是独立发行包。安装不注册 Windows 服务、计划任务或开机启动，也不修改 PATH。

## 安装与使用

在普通用户终端进入 `D:\TODO\qingdan-canvas`。需要 Node.js 24 或以上、执行过 `npm ci`，以及与 `runner/protocol-version.json` 完全一致的 Codex CLI。安装会读取 `QINGDAN_CODEX_BIN`；未配置时在 Windows PATH 中查找 `codex.exe`。

```powershell
npm run agent:install
npm run agent:start
npm run agent:diagnose
```

安装记录当前 Node 和 Codex 路径，生成 `.tmp/agent-install/agent.ps1`，并生成仅当前 Windows 用户和 SYSTEM 可访问的控制密钥目录。安装不会替你登录账号或 Codex。服务可用后，在 <http://127.0.0.1:8790> 登录并进入画布。

生成的入口可以在其他工作目录使用：

```powershell
& 'D:\TODO\qingdan-canvas\.tmp\agent-install\agent.ps1' -Action diagnose
& 'D:\TODO\qingdan-canvas\.tmp\agent-install\agent.ps1' -Action start
& 'D:\TODO\qingdan-canvas\.tmp\agent-install\agent.ps1' -Action stop
```

也可使用源码中的入口：

```powershell
.\scripts\agent.ps1 -Action diagnose
node scripts/agent-install.mjs diagnose
```

本机 PowerShell 执行策略若限制 `.ps1`，使用 npm 或 Node 入口即可。安装目录绑定 checkout 的绝对路径；移动 checkout、更新 Node 路径或切换固定 Codex 版本后，应停止服务，再重新安装。

## 启动、停止与重启

`start` 隐藏启动一个独立 Node 进程，将输出追加到 `.tmp/agent-install/service.log`。它不打开终端窗口，也不自动打开浏览器。启动前检查 8790 和 8788；发现其他入口占用时明确报错，不接管、不关闭占用者。

控制端先通过随机挑战和 HMAC 验证安装身份、checkout、PID 和实例 ID。只有认证通过才发送状态或停止指令，不能仅凭一个 PID 终止进程。重复 `start` 返回相同 PID、相同 `instanceId` 和 `alreadyRunning: true`。

初次启动最多等待约 60 秒。`ready: true` / `status: "running"` 需要认证成功，且通过 8790 的 `/api/session` 返回可识别的成功响应；只连上控制桥不足以判定就绪。如果应用还在构建，返回 `ready: false` / `status: "starting"`，之后运行 `diagnose`。应用进程在等待期间退出则启动失败，日志保留。

```powershell
npm run agent:stop
npm run agent:restart
```

停止前只读检查当前 checkout 下的体验会话和执行日志。存在活动任务、需要复核的会话或不可读的状态时，普通停止和重启会拒绝。普通 `restart` 需要原任务已经结清；任务之间的持久化暂停仍可能保留 `active=1`，此时也会被拒绝。确实需要中断原批次、取消余下任务时，明确传入：

```powershell
npm run agent:stop -- --interrupt-active
# 或：npm run agent:restart -- --interrupt-active
```

这会让已认证启动器走自己的退出流程，关闭执行控制器和它启动的子进程，并取消尚未执行的剩余任务。`--interrupt-active` 不是暂停批次后继续原批次的操作。停止若仍未结束，会报错并保留身份记录供诊断；安装器不会按超时强杀一个 PID。

并发的安装、启动、停止和卸载通过独立 `operation.sqlite` 的 SQLite 写事务互斥。第二个命令若遇到正在进行的操作，会要求稍后重试，不会另开一个实例。事务由连接持有，命令异常退出后由系统释放；数据库文件本身会保留，不代表仍有操作运行，也不应为“解锁”而删除它。早期开发版本遗留的 `operation.lock` 不再用于互斥。

## 诊断状态

```powershell
npm run agent:diagnose
Get-Content .\.tmp\agent-install\service.log -Tail 80
```

| 状态            | 含义和处理                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------- |
| `not_installed` | 没有安装记录。先运行 `agent:install`。                                                      |
| `stopped`       | 没有已运行的受管实例，固定端口空闲。                                                        |
| `starting`      | 控制身份已验证，应用健康检查尚未通过。查看日志并稍后诊断。                                  |
| `running`       | 控制身份已验证，应用会话 API 可用；不表示已登录、执行器已配对或任务成功。                   |
| `stopping`      | 已收到停止请求，仍在关闭。                                                                  |
| `unmanaged`     | 未运行受管实例，但 8790/8788 被占用。回到原启动终端明确关闭那个开发服务，再启动本安装。     |
| `unverified`    | 记录中的 PID 仍存在，但控制身份不能通过验证。不要删除记录后强行接管；检查原进程和安装目录。 |
| `stale`         | 记录中的进程已不存在。`stop` 只移除这条过期记录，不杀任何进程；随后可 `start`。             |

诊断还返回实际端口占用情况、安装时的 Codex 版本、当前命令使用的 Node 版本、日志路径，以及活动/未知状态计数。密钥、账号凭据和任务内容不出现在诊断输出中。

如果安装、启动或控制命令报告 `Invalid installation control key`，说明密钥文件为空、写入不完整或格式损坏。安装器会拒绝使用该密钥，保留原文件和现有安装身份供诊断，不会通过重新安装静默替换正在运行实例的密钥。不要把密钥内容粘贴到诊断报告中。

在 Codex AppContainer 等受限令牌中，收紧目录 ACL 后可能出现 `EPERM/EACCES`。这是已实测的受限环境差异：请在同一 Windows 账号的普通终端运行安装管理命令；不需要把密钥目录开放给所有用户。自动验证使用非 AppContainer 上下文。

## 断连或本机服务重启后的处理

恢复服务后，进入原画布的 Agent 面板，在电脑设置查看真实连接与版本，在批次入口定位原批次。打开面板和查看诊断本身不会创建新的执行。保持原批次、run、thread 身份，先核对执行事件、完成回执和清单回写，再决定下一步。

界面操作顺序：

1. 本机服务已停止时运行 `npm run agent:start`，再进入「电脑与项目设置 → 诊断与恢复」，确认连接并打开原运行。
2. 原批次在暂停点显示「核对并恢复连接」时，点击它。系统核对原生会话历史、验收与清单回写、目录锁和租约身份；核对失败会保留阻断并显示原因，不会重新提交任务。
3. 核对通过后批次仍暂停；点击「继续批次」才推进剩余待办。已完成的待办保持完成。整个批次已完成时，只需查看结果，不再创建或继续执行。

正常使用 `restart` 时应先让任务结清。此次真机恢复验证在任务之间的持久化暂停点终止已确认属于测试的服务进程，模拟异常退出，再 `start` 恢复；这是受控故障注入，不是普通 `restart` 续跑，也没有重启整台电脑。异常退出若发生在原生执行已经开始、完成回执却尚未可靠保存的窗口，恢复后可能需要复核。不能把“超时”“离线”或“没有收到成功回执”直接等同于“任务没有执行”，也不能据此重新提交同一任务。

此安装器只负责本机服务生命周期。连接恢复、批次恢复和不重复执行的具体保证，以对应恢复故障测试和[本次真机验收记录](agent-install-recovery-verification-2026-11-05.md)为准。

## 卸载与保留数据

```powershell
npm run agent:stop
npm run agent:uninstall
```

卸载要求受管进程已经停止，仅删除安装清单和生成的 `agent.ps1`。默认保留：

- `service.log`、控制密钥及安装目录内其他日志；
- `.tmp/runner-device`、`.tmp/agent-experience`、`.wrangler`；
- Windows Credential Manager 中的凭据、Codex 登录信息、`.dev.vars`；
- 已注册工作目录及其中的文件。

卸载不做递归删除，不撤销远程设备，也不清除任务记录。重新安装复用保留数据。若需要撤销设备或清理数据，在相应界面另行明确操作。

隔离测试可传 `--state-dir <checkout>\.tmp\agent-install-<名称>`。只允许当前 checkout `.tmp` 的直接子目录 `agent-install` 或 `agent-install-<名称>`，并拒绝链接和 junction；它仍使用相同应用端口和数据目录，不能当成多套应用并行运行。

## 已执行的自动验证

```powershell
node --test tests/agent-install.test.mjs
```

测试使用临时 checkout 和真实独立 Node 进程，仅注入固定端口/健康检查边界，避免影响已运行开发服务。覆盖完整生命周期、重复启动的实例一致性、陌生 PID 与过期记录、错误密钥、真实占用端口、活动及不可读任务状态、启动中和启动崩溃、并发操作锁、过期锁并发争用、空锁残留和持锁进程崩溃恢复、带中文/空格/单引号路径的 PowerShell 入口、junction 拒绝，以及卸载后的数据和密钥保留。过期锁竞争回归通过调度文件读写顺序稳定复现旧实现的竞态，保留真实文件读写。自动测试不替代真实应用的网页就绪和恢复验收。
