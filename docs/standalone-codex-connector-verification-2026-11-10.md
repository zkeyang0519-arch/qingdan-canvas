# Codex 连接器 0.1.1 验证记录

验证时间：2026-11-09 至 2026-11-10，Asia/Shanghai。结果：本轮独立连接程序的自动化、真机协议、界面与最终发行包验证通过。

## 交付与运行

- [Windows x64 便携 ZIP](D:/TODO/qingdan-canvas/codex-connector/release/Codex-Connector-0.1.1-win-x64.zip)
- [本机启动入口](<D:/TODO/qingdan-canvas/codex-connector/release/Codex-Connector-0.1.1-win-x64/启动 Codex 连接器.vbs>)
- [备用启动入口](D:/TODO/qingdan-canvas/codex-connector/release/Codex-Connector-0.1.1-win-x64/start.cmd)
- [源码与操作说明](D:/TODO/qingdan-canvas/codex-connector/README.md)

解压到可写目录，双击“启动 Codex 连接器.vbs”；系统禁用脚本时运行 start.cmd。包内自带 Node，无需安装 npm 或启动轻单服务器。本机需已安装兼容 Codex；未登录时在 Codex 中登录后重试。面板里的“退出连接器”会关闭后台，单独关闭网页不会退出。

## 修复内容

| 问题 | 修复与回归验证 |
| --- | --- |
| 检查版本时退出，稍后仍可能启动 app-server | 版本探测可取消，关闭等待探测结束，启动前再次检查关闭状态；用延迟版本子进程证明旧代码失败、修复后无残留进程。 |
| 写入配置时连接断开，仍可能显示已连接 | 保留探测期间断开原因，保存后复核实际连接状态；在保存期间终止模拟 app-server，验证状态为错误并安排有限重试。 |
| 重用旧输出目录可能把本机数据打进发行包 | 打包只接受不存在的新目录；已有目录明确拒绝，不覆盖原数据。用含敏感哨兵文件的旧目录验证拒绝和保留行为。 |
| 修改搜索输入后点“更多”会混用不同查询 | 分页固定使用已经提交的搜索词；DOM 回归覆盖修改未提交输入后的分页。 |

以上回归均先观察旧实现失败，再修改并验证通过。

## 自动化与真机结果

`node --test codex-connector/tests/*.test.mjs`：**42 通过，0 失败，0 跳过**。覆盖发现路径、版本限制、stdio 握手与响应校验、超时与进程退出、连接状态竞争、HTTP 凭据与来源检查、UTF-8 请求、单实例、打包隔离，以及面板交互。最终发行包核对后又对同一份源码运行全量测试，结果相同：[完整 TAP 日志](D:/TODO/qingdan-canvas/docs/verification-assets/codex-connector-0.1.1-tests.tap)。

真实便携包测试使用 Windows、随包 Node v24.18.0、Codex 0.167.0-alpha.3.2。执行命令：

```powershell
node codex-connector/tests/portable-smoke.mjs codex-connector/release/Codex-Connector-0.1.1-win-x64
```

| 验收项 | 实际结果 |
| --- | --- |
| 脱离源码目录运行 | 复制到含中文和空格的新目录；移除 PATH 中的系统 Node，随包运行时启动成功。 |
| 自动发现、协议、登录状态 | 自动找到本机 Codex，四项检查通过，状态 ready。 |
| 会话与项目 | 读取第一页 50 个、第二页 50 个会话；选中会话的项目匹配且目录存在。 |
| 重复启动 | 复用原实例和进程，不额外创建连接器实例。 |
| 访问保护 | 未带本机凭据的 API 请求返回 401；诊断无访问凭据或原始可执行文件路径。 |
| 错误恢复 | 无效手动路径明确报错；恢复自动发现和重新连接均成功。 |
| 正常退出 | 连接器和测试期间记录的两个直属子进程已退出，运行凭据文件已移除。 |
| 实际浏览器面板 | 搜索、项目目录显示、错误路径提示、恢复自动发现、退出状态均观察通过；控制台无错误或警告。 |
| ZIP 中的启动器 | 最终 ZIP 解压至另一个全新中文/空格目录；VBS 冷启动成功，CMD 备用入口复用成功，退出清理通过。 |

浏览器验收使用单独数据目录；真实检查只读访问 Codex 元数据，没有提交模型任务或改变轻单设备绑定。测试实例均已退出。

## 发行包核对

ZIP 大小：35,704,910 字节。17 个文件与清单完全一致，包内应用源码与测试后的源码逐文件哈希一致；没有 data、账号凭据、会话历史或临时运行文件。

ZIP SHA-256：

```text
5ec10e124e3b6403d7c20b0c0ab85e565b12e50659a41972077dbd4da0e8a961
```

记录：[真实连接报告](D:/TODO/qingdan-canvas/docs/verification-assets/codex-connector-0.1.1-portable.json)、[发行包核对](D:/TODO/qingdan-canvas/docs/verification-assets/codex-connector-0.1.1-package.json)、[启动器报告](D:/TODO/qingdan-canvas/docs/verification-assets/codex-connector-0.1.1-launcher.json)。这些报告不包含访问凭据、会话正文或账号邮箱。

![真实面板的已连接状态与项目读取结果](D:/TODO/qingdan-canvas/docs/verification-assets/codex-connector-0.1.1-connected.jpg)

## 已验证范围

这是独立的本机连接程序，提供连接检查、登录状态和会话/项目读取。本轮没有实现任务执行、云端网页接入或开机启动，也没有声称修复现有轻单网页的所有连接问题。

当前真机验证为 Windows x64 与上述 Codex 版本。其他 Codex 版本会明确提示不兼容，不能据本次测试推断已兼容所有新电脑。便携包尚未做发行签名。
