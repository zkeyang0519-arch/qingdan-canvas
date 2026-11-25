# 工作区与轻岛升级验收

功能入口：设置 → 对话模型 / 工具与 Agent / 个人偏好；项目资料 → 概览 / 约定与经验；轻岛设置 → 本地服务 / 版本更新。

原模型和 MCP 配置保存在原有账号与项目作用域，界面重排不会重建连接。原个人记忆归个人偏好，原项目记忆归项目约定。新增沉淀保留任务来源与适用条件，避免把进度、实时连接状态或一次授权当成长期规则。

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

`.github/workflows/desktop-update-acceptance.yml` 在一次性的 GitHub Windows runner 构建两份真实 NSIS 安装包。`scripts/verify-desktop-update.mjs` 安装第一版并通过实际 Electron 页面点击更新，只连接由安装器自动重启的第二版，不手动启动第二版。

验证实际安装资源、下载进度、HttpOnly 登录、待办及未确认操作编号、多行草稿、项目、外观、本地模型默认值、同一设备重连和绑定、MCP 配置、原远端回执与检查点。远端生成使用本机 MCP 夹具，重复恢复必须仍只有一次提交。输出 JSON 报告和前后截图作为 Actions artifact，不创建 Release，不部署网站。

预约/取消、重复点击、保存失败、未知任务、服务退出失败、安装失败与恢复分支由 `tests/desktop-update-runtime.test.mjs` 和 `tests/desktop-local-service.test.mjs` 覆盖。安装包内服务由 `scripts/test-local-service.mjs` 使用隔离目录真实启动、暂停、保存并恢复。

## 正式发布条件

正式签名证书在仓库 Secrets 中配置，不放在源码或聊天。正式标签工作流要求有效签名；用户当前选择先交付未签名验收包。正式部署仍按 `docs/cloudflare-setup.md` 手动执行。官网、更新源未通过在线校验前，不宣布正式发布完成；不自动降级用户数据。
