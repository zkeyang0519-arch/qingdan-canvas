# 工作区与轻岛升级验收

功能入口：设置 → 对话模型 / 工具与 Agent / 个人偏好；项目资料 → 概览 / 约定与经验；轻岛设置 → 本地服务 / 版本更新。

工具与 Agent 的服务详情按层展开：常用组合、功能分类、每页 8 项的工具列表、单独展开的完整说明。支持搜索全部工具及仅查看已启用工具；连接来源、授权和诊断收在“连接设置”，异常时自动展开。分类、搜索、翻页不会改变项目勾选，组合只添加工具；未来新增的未识别工具保留在“其他工具”中。

原模型和 MCP 配置保存在原有账号与项目作用域，界面重排不会重建连接。原个人记忆归个人偏好，原项目记忆归项目约定。新增沉淀保留任务来源与适用条件，避免把进度、实时连接状态或一次授权当成长期规则。

任务 Harness 默认不限制累计 token、累计模型请求或单轮请求次数，仍记录实际用量。旧预算暂停任务在用户下一次续跑时沿用原任务和回执，解除旧默认额度；不会在服务启动时自动恢复生成。显式配置的数值预算仍受检查。手动停止、超时、权限和结果验收保持有效；连续多轮没有新资料、工具结果或验收反馈时保存检查点并暂停，重复回执编号不算新进展。

任务后复盘在 Pi 验收完成或原生任务成功且停止确认后入队。沿用原任务模型，输入最多 24,000 字符，输出预算 2,400 token，超时 30 秒，最多产生 3 条建议。失败不会改变原任务结果；中断的复盘需要手动重试。存储回执和记忆指纹阻止重复保存，撤销/删除会抑制旧建议再次出现。

## 本地验证

```powershell
npm test
npm run check
npm run runner:check
npm run deploy:check
npm run desktop:service:package
node scripts/test-local-service.mjs
```

两份未签名验收包分别设置 `QINGDAO_BUILD_VERSION=0.3.12-beta.1` 和 `0.3.12-beta.2`，设置不同 `QINGDAO_OUTPUT_DIR` 后执行 `npm run desktop:package` 与 `npm run desktop:inspect`。Beta 端口为 localhost:8794（工作区）、8793（Worker）和 8795（唤起桥）。正式版继续使用原端口和身份。

## 真实更新验收

按本次用户选择，先在本地进行隔离验收。`scripts/prepare-local-desktop-update.mjs --isolated-local <第一版输出目录> <第二版输出目录>` 仅在没有既有 Beta 安装、测试端口空闲时，安装到新建的工作区临时目录；账号、模型、MCP、绑定和回执均为测试数据。使用原生 Beta 窗口操作更新，`/qa/verify` 核对自动重启后的后台数据。此模式不开放调试端口，正式版不能使用本地验收更新源。

`.github/workflows/desktop-update-acceptance.yml` 可手动在一次性的 GitHub Windows runner 构建两份真实 NSIS 安装包。`scripts/verify-desktop-update.mjs` 安装第一版并通过实际 Electron 页面点击更新，只连接由安装器自动重启的第二版，不手动启动第二版。

验证实际安装资源、下载进度、HttpOnly 登录、待办及未确认操作编号、多行草稿、项目、外观、本地模型默认值、同一设备重连和绑定、MCP 配置、原远端回执与检查点。远端生成使用本机 MCP 夹具，重复恢复必须仍只有一次提交。输出 JSON 报告和前后截图作为 Actions artifact，不创建 Release，不部署网站。

预约/取消、重复点击、保存失败、未知任务、服务退出失败、安装失败与恢复分支由 `tests/desktop-update-runtime.test.mjs` 和 `tests/desktop-local-service.test.mjs` 覆盖。安装包内服务由 `scripts/test-local-service.mjs` 使用隔离目录真实启动、暂停、保存并恢复。

## 正式发布条件

正式签名证书在仓库 Secrets 中配置，不放在源码或聊天。正式标签工作流要求有效签名；用户当前选择先交付未签名验收包。正式部署仍按 `docs/cloudflare-setup.md` 手动执行。官网、更新源未通过在线校验前，不宣布正式发布完成；不自动降级用户数据。
