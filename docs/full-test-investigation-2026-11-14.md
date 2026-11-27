# 全量测试失败排查与修复

日期：2026-11-14。代码基线：`72bf01c`（轻岛 0.3.3），工作分支：`feat/qingdan-mcp`。环境：Windows、Node.js 24.18.0；使用 `npm test` 的默认并发，不跳过测试、不自动重跑失败用例。

最终结果：两处清理问题修复后重新完整运行，**1646/1646 通过，0 失败、0 跳过、0 取消**，退出码 0，耗时 191.5 秒。

## 原始失败原因

上次全量运行被提前终止，日志没有完整的失败栈，因此原先不能认定为业务代码缺陷。本次选取聊天模型、项目摘要和聊天历史草稿恢复三个原失败用例，在相同代码下作对照：

- 受限环境中三项都在连接 Miniflare/workerd 测试服务时出现 `fetch failed`。
- 最小本机 HTTP 探针进一步确认 `connect 127.0.0.1` 返回 `EACCES`，即执行环境不允许连接测试用的回环网络。
- 在获准使用本机网络的环境中，同样三项全部通过；随后第一轮全量 1645/1645 通过。

这批原始失败来自执行环境。测试仍使用独立临时数据库、模拟模型和临时端口，不使用正在运行的用户 Agent、桌面档案或生产数据库。

## 发现并修复的测试代码问题

### 初始化失败后没有清理 Worker

`tests/fixtures/chat-recovery-server.mjs` 原本等数据库初始化和 HTTP 监听全部完成后才登记清理回调。数据库连接失败时，已有 workerd 实例没有被释放，导致测试失败后进程仍不退出。

现在创建临时目录后即登记清理；无论构建、数据库还是监听哪一步失败，都尝试关闭 HTTP 服务、释放 Worker 并删除临时目录。监听错误也会使初始化 Promise 拒绝，不再留下未处理的监听错误。

新增 `tests/chat-recovery-fixture.test.mjs`：启动真实 Worker 后注入数据库初始化失败，验证清理仍会调用真实的 `dispose()`。同一受限环境中的草稿恢复用例也已复核：仍如实报告网络失败，但约 7.5 秒内正常退出，退出码为 1，不再挂住。

### Windows 临时目录短暂占用

加入上述回归后的全量运行有 1645/1646 通过，唯一失败是安装生命周期用例清理临时根目录时的 `EBUSY: resource busy or locked, rmdir`，并非待办或聊天断言失败。检查时该测试的运行记录已移除，也没有找到仍使用该唯一临时路径的测试子进程；不能据此追溯断言失败瞬间具体是哪一个系统句柄持有了目录。

`tests/agent-install.test.mjs` 现在对递归清理使用 Node 的有限重试（最多 10 次、递增间隔基数 100 毫秒），处理 Windows 退出后的短暂目录占用。仍有活进程且停止失败时保留停止错误，持续锁定则仍使测试失败。没有修改启动等待时间、业务断言或整条测试的重试策略。

相关生命周期与初始化清理回归合计 22/22 通过。

## 验证记录

| 验证 | 结果 |
| --- | --- |
| 原失败三项在允许本机网络的环境中对照运行 | 3/3 通过 |
| 第一轮默认全量 | 1645/1645 通过 |
| 加入初始化清理回归后的全量 | 1645/1646 通过；一项 Windows 目录清理 EBUSY，已修复 |
| 两处清理修复的定向回归 | 22/22 通过 |
| 两处修复后的最终 `npm test` | 1646/1646 通过，0 失败、0 跳过、0 取消，191.5 秒 |
| `npm run check` | 通过 |
| `npm run deploy:check` | 通过；仅构建与 dry run，未发布 |

本次修改限于测试代码与排查记录；未修改产品功能或线上配置。

## 本机证据

- `.tmp/update-entry-tests.log`：此前中止的原始运行。
- `.tmp/full-test-sandbox-diagnosis.log`、`.tmp/full-test-unsandboxed-diagnosis.log`：同代码环境对照。
- `.tmp/full-test-sandbox-cleanup.log`：修复后受限环境失败能正常退出。
- `.tmp/full-test-investigation-initial.log`：第一轮全量。
- `.tmp/full-test-investigation-final.log`：发现 Windows 清理占用的那一轮，保留其失败结果。
- `.tmp/full-test-cleanup-regression.log`：22 项定向回归。
- `.tmp/full-test-investigation-verified.log`：两处修复后的完整全量日志。
- `.tmp/full-test-investigation-build.log`：构建与部署预检。
