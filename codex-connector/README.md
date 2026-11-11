# Codex 连接器

独立的 Windows 本地连接检查程序。自动发现 Codex，显示握手和授权状态，搜索/分页读取会话，核对项目位置。所有接口只读，不创建任务、不续写旧会话、不依赖轻单账号或服务器。

## 运行

便携包解压到可写目录后，双击“启动 Codex 连接器.vbs”；系统禁用 WSH 时运行 `start.cmd`。包内自带 Node。关闭网页后后台继续运行，使用面板“退出连接器”关闭。重复启动会重新打开已有实例的面板。

源码运行（在项目根目录，Node 24）：

```powershell
node codex-connector/main.mjs --open --data-dir .tmp/codex-connector-live
```

当前测试的 Codex：`0.167.0-alpha.3.2`。找不到时可指定原生 codex.exe 路径；版本不兼容会明确提示，不跳过协议检查。未登录时请先在 Codex 中完成登录。本程序保留 Codex 原有配置，不保存或复制其登录凭证。

## 验证与打包

```powershell
node --test codex-connector/tests/*.test.mjs
node codex-connector/tests/live-smoke.mjs .tmp/codex-connector-live-smoke
node codex-connector/package-windows.mjs .tmp/codex-connector-release-0.1.1
node codex-connector/tests/portable-smoke.mjs .tmp/codex-connector-release-0.1.1
```

测试用模拟 stdio 进程，不调用模型。live-smoke 只读访问真实会话，报告不含会话标题、路径或账号邮箱。网络沙箱可能阻止回环 HTTP 测试，需允许本机测试连接后运行。

打包必须使用不存在的新目录；重复打包到已有目录会明确拒绝，保留原有数据。portable-smoke 在另一个带中文和空格的目录中测试随包运行时、去除系统 Node 的 PATH、重复启动、路径错误恢复与退出清理，不向发行目录写入运行状态。

仅监听 127.0.0.1；API 校验随机 Bearer 凭证、Host 与 Origin；没有任意命令或 RPC 透传入口。启动 URL 的片段凭证用于面板首次认证，随后从地址栏移除。实例凭证和配置放在指定数据目录，诊断导出排除这些内容。只结束程序自己创建的 Codex 子进程。

本轮范围为连接功能；不含任务执行、云端转发、安装服务或开机启动。便携包未做发行签名；支持范围以实际测试报告为准。
