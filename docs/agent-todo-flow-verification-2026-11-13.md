# Agent 待办输入与收集区验证（2026-11-13）

本轮在 `feat/qingdan-mcp` 的现有工作区增量修改，保留此前未提交内容。没有提交、发布或修改用户设备绑定。

## 六项核对

| 用户事项 | 实现与验证 |
| --- | --- |
| 输入位置与保存跳动 | 添加入口及输入行放到未完成列表底部。成功提示移到下方；正常在途请求不再展开上方的恢复面板。桌面连续保存两次，已有首行纵坐标保持不变；30 项长列表保存后输入仍在视口内。 |
| 简化执行要求与验收区域 | 新增只保留正文一行，移除新增区的执行要求、验收方式和完成标准。支持 Enter、Shift+Enter、输入法 Enter、Esc、失败保留草稿。已有任务的详细编辑及保存条件保持兼容。 |
| 执行完自动收起 | 真正 `done` 的任务移入收集区；整组执行正常结束且确认停止时，只收起与提交来源版本一致的任务，标注“执行已结束，待核对”。取消、原生运行失败、新尝试和已改动来源保留在主列表。没有自动写入逐项验收状态。 |
| 全选待办 | 有全选、取消全选和部分选中状态；过滤空白、完成、收起、锁定、待重新确认项；每批上限 50 项，超限提示并按列表顺序选前 50 项。选择不会启动执行。 |
| 已完成收集框 | 默认折叠，计数可见；区分已确认完成与已执行待核对，保留删除入口，待核对项可移回待办。桌面和 390px 触屏均检查。 |
| 待办数量多一项 | 空白编辑行、未保存输入、正文便签不计数；已收起项单列为待核对；截断到 200 项的接口不会覆盖完整画布总数。201 项回归通过，解绑后回到未绑定清单的计数。 |

设计参考：[Microsoft To Do 官方创建待办说明](https://support.microsoft.com/en-us/todo/create-edit-delete-and-restore-tasks)，采用回车保存与底部追加。

## 测试和证据

- 定向回归：`node --test tests/agent-checklist-ui.test.mjs tests/agent-workspace-shell.test.mjs tests/agent-checklist.test.mjs`，90/90 通过。记录：`.tmp/agent-todos-green.log`。
- 新增回归在修改前观察到预期失败，覆盖空白计数、底部输入、完成分组、全选上限、保存时布局、编辑中远端完成、历史窗口滚动、跨客户端新尝试、超长清单和未绑定计数。
- `npm run check` 通过：`.tmp/agent-todos-check-final.log`。
- `npm run deploy:check` 通过，只执行构建和 dry-run：`.tmp/agent-todos-deploy-check-final.log`。仍有构建大分包提示，不影响通过。
- 首次 `npm test`：1370/1371 通过。`agent-lifecycle-control.test.mjs` 的 `source recovery uses authenticated local control without an installed manifest or backend session` 在测试临时目录出现文件重命名 `EPERM`；该文件独立复验 3/3 通过，记录：`.tmp/agent-todos-lifecycle-recheck.log`。
- 最终 `npm test`：1372/1372 通过、0 失败，退出码 0（`.tmp/agent-todos-full-tests-final.log`）。
- 独立审查提出的四项问题均修复并有回归覆盖：近期运行窗口导致收起状态丢失、轮询遗漏新运行、截断数据少计数、解绑遗留旧计数。

浏览器使用项目真实 React 组件和 CSS、隔离的模拟接口以及全新的 Edge 无头浏览器上下文，不连接用户账号或 Runner：

- 脚本：`.tmp/agent-todo-browser/verify.mjs`、`.tmp/agent-todo-browser/mobile-verify.mjs`。
- [桌面连续输入](../.tmp/agent-todo-browser/desktop.png)、[展开收集区](../.tmp/agent-todo-browser/completed.png)、[长列表](../.tmp/agent-todo-browser/long-list.png)、[390px 触屏](../.tmp/agent-todo-browser/mobile-touch.png)。
- 1440px 桌面、30 项长列表、390px 触屏均通过；保存期间已有行位置未变、输入焦点保留、全选和移回操作正常、无横向溢出。浏览器未捕获页面异常。
- CUA 与 node_repl 工具均因 kernel assets 路径错误未能启动，故使用项目临时目录中的 Playwright Core 和已安装 Edge 验证，没有改动项目依赖。

## 验证边界

- 未另外发起真实 Codex 执行，未做生产部署。执行收起的浏览器验证使用模拟运行状态，真实回执、版本和执行协议由已有回归覆盖。
- 已观察到的运行状态和“移回待办”偏好按当前浏览器、账号、画布及绑定保存。清除浏览器数据或换浏览器后，只能从服务端近期运行重建收起状态；不把本地显示状态当作验收通过。
- 本轮只处理这六项，没有启动其他待办。
