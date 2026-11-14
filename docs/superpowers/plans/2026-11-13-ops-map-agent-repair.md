# 运维部署地图与 Agent 绑定修复

**Goal:** 将用户已选定的 C 部署地图接入真实运维资产，并修复项目选择、模型同步和快速模式，简化 Agent 界面。

**Architecture:** 沿用 React / Workers / 本机 Runner 架构和现有资产数据；在当前包含前序改动的工作区增量修改，不重置既有工作。按互不重叠的文件划分并行实现。

**用户要求与设计:** 运维默认展示 C 部署地图，按后续反馈统一为轻单的白色、浅灰绿与绿色强调色，真实产品和服务器依赖可选择、筛选和编辑；绑定界面重新组织设备和项目列表；已用项目读取 Codex 当前模型及状态，执行设置提供真实可选模型和快速模式；去掉聊天内重复标题，用户消息靠右且最大宽度为 60%；移除字体宣传句和重复说明，保留必要错误、操作反馈及许可文件。

## 约束

- 工作目录 D:/TODO/qingdan-canvas。保留现有未提交改动；不提交、发布或重绑用户设备。
- 不写死模型列表或虚构支持能力；核查本机接口、Runner、协议及 UI 数据流。
- 不混用用户开发数据与自动测试数据；测试启动独立 workerd。
- 使用现有版本、回执与账号隔离规则。设计调整不削弱只读权限和可访问性。

## 任务

- [x] 1. 运维：检查 src/ops 与 output/ops-design-exploration-2026-11-13 的 C 预览；实现真实部署地图、选择详情、搜索筛选与窄屏布局，验证资产操作。
- [x] 2. 绑定：定位项目无法选择的原因；修复 src/agent/ProjectBindingPicker.jsx、CodexProjectPicker.jsx 并重做绑定布局。增加覆盖实际失败路径的回归测试。
- [x] 3. 模型：追踪 scripts/lib/local-runner-api.mjs、runner、execution-settings.js、ExecutionSettings.jsx 与 ChecklistPanel.jsx；修复实际模型目录、状态同步和快速模式传递；验证已用项目及保存设置。
- [x] 4. 聊天与文案：调整 AgentWorkspace、ChatPanel 与聊天样式；清除重复装饰性提示；保留必要状态和错误。
- [x] 5. 集成：审查各项变更，运行 npm test、npm run check、npm run deploy:check 与 Runner 检查；在实际界面检查宽窄屏、绑定、模型设置和部署地图。

## 验收证据

根因、测试结果、页面检查和接口限制见 `docs/ops-map-agent-repair-verification-2026-11-13.md` 及 `output/ops-map-agent-repair/` 分项报告。模型状态同步限于接口提供的最近项目会话与有效配置，不推断桌面实时活动。
