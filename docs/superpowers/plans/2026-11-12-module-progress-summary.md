# 模块进度与历史分页 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this approved plan in the current workspace. The user explicitly requested direct implementation.

**Goal:** 解决历史正文在一次性上下文中截断的问题，并按项目背景、模块当前进度、剩余工作、下一步展示结果。

**Architecture:** 本机保存完整脱敏历史快照，模型通过有界动态工具逐页获取；原生记录已交付范围与可恢复的归并笔记，未读完不能提交完整结果。新结构增加背景与模块，旧摘要继续兼容；记录覆盖放入独立详情。

**Tech Stack:** TypeScript, Node.js 24, Codex app-server dynamic tools, React, SQLite.

**Spec:** 本聊天 2026-11-12 已批准的方案及用户“按这个方案直接修改”的指令。

## Global Constraints

- 当前分支 feat/qingdan-mcp 有已授权的未提交功能，本次依赖这些改动；原地修改并保存本次基线，不覆盖、不提交其他工作。
- 分页不删掉较旧记录，不截去长记录尾部；用户需求及非完成轮次状态只能作为背景/状态，不能作为完成证据。
- 来源隔离、脱敏、停止、原生授权和旧运行恢复必须继续有效；本次不部署线上。
- 新报告从历史及明确提供的背景形成；不重新全盘扫描代码、不声称重新执行测试，不编造完成百分比。

## Review Focus

- 超过原 120000 字符的历史及超过 16000 字符的单条记录完整分页，中文/emoji/JSON 转义也满足响应上限。
- 游标重试、跨快照游标、乱序读取与重启不错误推进覆盖；停止后不继续交付。
- 旧摘要及旧工具注册继续恢复；新报告未读完或引用未交付来源时拒收。
- 背景、模块及待办通过结构校验、聊天持久化及 UI 展示，不因新字段在下游丢失。
- 空历史/部分读取失败明确显示覆盖缺口，状态与建议不能伪装为验收。

## Tasks

- [x] 1. 历史采集与分页：先回归原预算丢失、长记录尾部、用户要求和进行中状态；移除总输入裁切，新增有界分页、游标和归并笔记状态，验证完整重组与重试。
- [x] 2. Runner 集成：只传历史目录信息，注册分页工具、持久化已读位置；拒绝过早回执。通过真实 RPC 假服务测试分页、恢复、停止和旧记录兼容。
- [x] 3. 模块报告：新增兼容性类型/校验/提示词；按背景和模块渲染 UI 与聊天，覆盖详情折叠。测试结构校验、展示及持久化。
- [ ] 4. 验证与本机生效：定向测试、npm test -- --test-concurrency=4、npm run check、npm run runner:check、npm run deploy:check；独立代码审查、隔离真实 Codex 验收；确认无活跃执行再更新本机服务。

## Execution Ledger

- Pre-flight: Task 1 provides immutable history and paged read state to Task 2. Task 3 extends persisted ProjectSummary optionally, but new runs require background/modules. Existing arrays remain for old consumers. No interface conflict.
- Baseline: existing dirty work retained; review against a per-file baseline under .tmp/module-progress-baseline, not HEAD.
- Task 1–3: targeted tests RED→GREEN (history retention/pages, RPC delivery, premature result rejection, schema/chat/UI). Existing summary fixtures updated to use the registered read tool; legacy runs keep their original tools.
- Independent review: two P2 findings reproduced and fixed RED→GREEN: null/omitted initial cursor replays the initial page instead of advancing; augmented report revalidated after native coverage injection. Added final-page receipt proof, restart/replay and stop-between-pages tests. Legacy evidence validators also check module references.
- Live test: .tmp/module-progress-live-FdZAR5/result.json; actual Codex read a 10,506-character requirement across four pages and produced three modules, retaining the final correction prioritizing undo over CSV. Isolated project file hashes unchanged. Final receipt-enabled rerun and full checks pending.
- Final live test: .tmp/module-progress-live-FMNSCK/result.json; receipt-enabled actual Codex run passed in 55.4 seconds, four pages and two merged modules, preserving the final requirement correction and unchanged project file hashes.
- Actual project corpus: .tmp/module-progress-corpus-result.json; 53 threads / 444 records / 468249 characters, 91 pages, maximum 9747 bytes per page, zero omissions/truncations/read failures. This verifies collection and page delivery, not a fresh model report for the user's live project.
- Full verification: npm test -- --test-concurrency=4 passed 1269/1269 in 183.3 seconds (.tmp/module-progress-full.log). npm run check, npm run runner:check, npm run runner:build and npm run deploy:check passed; deploy was dry-run only. Browser preview of the actual live-test result shows background, module status/current/remaining/next steps and collapsed source details.
