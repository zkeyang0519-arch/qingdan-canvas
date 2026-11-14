# 分支整理记录

2026-11-14 按用户要求，仅保留 `agent` 和 `main`。日常开发目录仍为 `D:/TODO/qingdan-canvas`，原 `feat/qingdan-mcp` 改名为 `agent`。

## 改动核对

| 原分支 | 保留情况 |
| --- | --- |
| `codex/agent-node-recovery` | 提交已在 Agent 和 main 历史中。 |
| `develop`、远程 `develop` | 提交已在 Agent 和 main 历史中。 |
| `feat/arranged-project-labels` | 提交已在 Agent 和 main 历史中。 |
| `codex/qingdao-install-update` | 经 PR #18 进入 main，本次同步到 Agent。 |
| `codex/qingdao-title-width` | 经 PR #19 进入 main，本次同步到 Agent。 |
| `codex/avatar-toggle` | 头像上传、创建者元数据与个人显示开关已整合至 `f90c233`，后续支持裁剪和 20 MB 原图；核心作者组件、迁移及测试文件与旧实现一致或已有后续演进。 |
| `feat/agent-dynamic-island` | `ca57dc4` 的实现已整合至 `e5ff81c`，后续按需求演进为桌面轻岛；项目偏好与相关测试保留，旧网页入口由桌面入口接替。 |

两个未以原提交直接合入的历史分支，在逐项核对后作为父提交保留到 Agent 历史；没有覆盖现有产品代码。整理后的产品树与 main 的 `5021343` 完全一致，之后仅新增本记录和分支约定。

头像作者与灵动岛偏好、交互专项复验 29/29 通过；未改动产品逻辑，因此没有重复运行全量回归。

## 工作区保留

- 当前未提交代码与 main 完全一致；仅四份旧验收文档落后，已采用 main 中补充后的版本。
- 清理前的全部 refs、stash 和未提交工作快照已保存为本机 `D:/TODO/qingdan-branch-backup-20261114/repository-before.bundle`，并通过 `git bundle verify`；恢复定位信息见同目录 `manifest.json`。
- 旧 worktree 的目录、忽略文件、测试产物和数据保留，解除分支关联后以 detached HEAD 留存。失效的头像 worktree 只清理 Git 登记，不删除磁盘目录。
- 原有 stash 保留；当前用户 profile、待办、登录、Runner 状态不参与清理。
- main 保持已发布的 0.3.2。Agent 功能仍在本地开发环境启用，生产开关不因分支整理改变。

## 后续流程

在 `agent` 完成开发与验证，再按用户授权合并到 `main`。发布桌面版本仍需提高版本号并创建对应版本标签；本次分支整理不创建新桌面版本。
