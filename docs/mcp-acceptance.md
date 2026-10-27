# MCP 本地验收与交付记录

日期：2026-10-27。工作分支：`feat/qingdan-mcp`。本地实现与自动验收已完成；**没有部署、远程迁移、创建云端资源、推送/合并分支或真实四客户端登录**。连接说明见 [接入指南](mcp-setup.md)，环境合同见 [配置](mcp-configuration.md)，发布步骤见 [Cloudflare 说明](cloudflare-setup.md#轻单-mcp-升级与发布)。

## 可重复的本地证据

自动测试使用生产 Worker/CanvasRoom、真实 Miniflare/workerd、独立 D1/KV/SQLite DO，所有持久化位于唯一 `.tmp/mcp-oauth-*`、`.tmp/mcp-storage-*` 等目录，结束后清理。合成账号 Alice/Bob、合成画布与 PKCE 公共客户端从发现、DCR、浏览器绑定与同意进入官方 token 交换及 MCP handler，没有用替代 JSON-RPC/OAuth 实现冒充互通。CIMD 的出站响应由隔离 fixture 提供；不会访问真实客户端元数据或发送邮件。

| 命令                                                              | 本次最终结果                                                                                                       |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `npm test`                                                        | exit 0，432/432，0 失败，38054.3059 ms（最终审查修复后）                                                          |
| `npm run check`                                                   | exit 0，`tsc --noEmit`                                                                                             |
| `npm run deploy:check`                                            | exit 0；Vite 2575 modules，5.12 s；Wrangler dry-run upload 1747.50 KiB / gzip 315.68 KiB，`--dry-run: exiting now` |
| `node --test tests/mcp-domain.test.mjs`                            | exit 0，37/37，0 失败，359.4026 ms；含最终审查新增 5 项根级筛选/容器元数据回归                                  |
| `node --test tests/mcp-oauth.test.mjs tests/mcp-storage.test.mjs` | exit 0，49/49，28288.1553 ms（大请求 fixture 加固前）；加固后完整 suite 的 OAuth21 + storage28 均通过              |

固定运行组合为 `agents@0.30.1`、MCP server/client SDK `2.3.1`、Cloudflare OAuth provider `1.2.4`、Zod `4.6.7`。真实 handler 接受 `2025-03-26` 的 initialize/list/call（初始化响应明确返回该版本），以及 `2026-07-28` 的完整现代每请求 envelope、协议 header 和 method/name header。旧版本响应可能为 SSE，现代结果为 JSON。这里只记录已测试的两个协议版本，不推断四个应用实际协商了哪一版。

独立全分支最终审查未发现 Critical 或 Important，记录的唯一 Minor 为开启收纳查询时未分组筛选误收直接位于收纳框的便签。该项已按先 RED（新增 5 项全部失败）、后 GREEN（domain 37/37）的流程修复，并完成上表全量验证；修复范围的独立复核待控制端执行。回归同时覆盖 note/task 搜索筛选、容器元数据和两种详情路径。

### 九工具与跨层覆盖

以下均由 `tests/mcp-oauth.test.mjs` 的真实 OAuth token → SDK/Agents → D1 → DO 流程调用。核心 subtest 为 `OAuth to all nine tools, WebSocket observation, concurrent note revisions, replay and recovery after revoke`；该用例还核对实际调用工具集合恰好为九个。

| 工具             | 实际结果断言                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------- |
| `list_canvases`  | Alice 仅返回 canvas，Bob 仅返回 other；Bob 读 canvas 被拒绝                              |
| `get_canvas`     | 获得所选画布 ID、结构/sequence；未选择或失去成员关系被拒绝                               |
| `search_content` | 查询命中、limit=1 分页、后续便签修改使旧 cursor 返回 `STALE_CURSOR`；默认排除收纳祖先    |
| `get_content`    | 读取实际任务 ID、作者、日期区间、备注与引用；显式读取收纳内容；中文大文本按字节分页      |
| `create_tasks`   | 在已有便签追加带日期/备注/引用的任务；同 ID/相同规范化输入重放完整原结果，改变输入被拒绝 |
| `update_task`    | 实际成功修改完成状态；与另一写调用并发时只有一个成功；锁定祖先拒绝                       |
| `delete_task`    | 实际删除并返回操作 ID、恢复期限，网页记录可见                                            |
| `create_note`    | 创建便签，已登录网页 WebSocket 收到相同 ID/revision 的变化                               |
| `update_note`    | 实际成功改便签颜色；不同段落仍按整便签 revision 发生冲突，收纳祖先拒绝                   |

同一跨层用例还通过普通网页 WebSocket 提交后续样式编辑，然后撤销 grant、确认旧 token 401，通过 Cookie 审计 API 恢复原删除，核对其他编辑、原作者和备注保留；更换恢复请求 ID 仍返回同一不可变结果。并发测试的两个工具在随后各有成功调用，不能仅凭一个失败请求计为写工具验收。

### 授权、存储与故障验证地图

| 要求                                                | 真实行为证据                                                                                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 发现、PKCE S256、固定 resource、Cookie 不可认证 MCP | OAuth suite：canonical discovery、S256/resource、PKCE verifier 失败/成功、Cookie-only 401                                                                                |
| 两账号/画布、只读与当前成员交集                     | OAuth suite 的 read-only challenge、selected canvas、Bob 跨画布拒绝、成员移除；storage suite 直接 DO 再检查 token/grant/成员/选择交集                                    |
| CSRF、重复/拒绝/账号切换/同账号新会话               | OAuth suite：同一已消费 handle 失败、空数组拒绝授权、10 分钟表单、错误 CSRF、账号/会话绑定；2000 画布选择与 1.25 MiB 端点 body 上限                                      |
| 刷新、绝对到期、撤销、密码变更和重设                | OAuth suite：refresh + revoke、D1 到期后访问/刷新失败、logout 保留连接、真实 password change/reset 后官方 provider access/refresh 失效；token 颁发 TTL=900 秒            |
| 激活失败、重叠同意、瞬时 D1 故障                    | OAuth suite：pending 不可用、已签发孤立 provider grant 被清理、重叠授权剩一个 active、新授权失败不撤旧授权、code/refresh 的瞬时故障 503 保留 provider grant 后可重试     |
| 全局幂等与跨画布 ID                                 | Storage suite：request routing reservation 后断交仍可恢复；更换画布/账号/命令/输入拒绝；对象、sequence、回执、删除快照在事务内提交                                       |
| 广播失败、重启、网页协议兼容                        | Storage suite：广播故障仍返回已保存成功；并发同键只执行一次；dispose/restart 后重放与恢复；旧网页 receipt 及 snapshot/ack 协议保留                                       |
| 收纳/锁定祖先、引用边界、作者与上限                 | OAuth 跨层用例覆盖祖先和中文结果分页；domain suite 补充全部写命令/嵌套祖先、跨画布/已收纳引用、50 项写批次、2000 对象及内容容量、单任务完整读取                          |
| 删除恢复权限与窗口                                  | Storage suite：原操作用户/当前成员、他人后续编辑、缺失目标、ID 碰撞、收纳/锁定、30 天过期；alarm 删除到期快照且保留成功回执                                              |
| 审计有界与最小投影                                  | Storage suite：本人 keyset 页、3000 个任务 ID 仅输出数量、无原始删除文本/输入/rows；SQL 只读摘要用到的六列                                                               |
| D1 临时生命周期清理                                 | Storage suite：105 条过期 open/selected/pending，一次清理 100，下一次清余项；活跃/撤销历史、未过期状态、请求绑定与成功 DO 回执不动；候选选择后激活胜出时 DELETE 重新检查 |
| 官方 CIMD 获取与缓存                                | OAuth suite：合成 HTTPS 元数据实际出站一次、第二次命中 provider cache、client_id 不匹配及 >5120 字节拒绝；无 HTTPS/无路径的 ID 不发起元数据请求                          |
| UI 与会话陈旧响应                                   | `tests/mcp-ui.test.mjs`：同意表单、权限选择、连接分页/撤销、独立恢复、错误/重试/重复点击锁、跨账号和同账号换会话旧响应丢弃                                               |

故意注入的 tree/snapshot/broadcast 故障，以及预期 provider OAuth/CIMD 和 SDK JSON 通知模式诊断，由 test-only fixture 捕获并逐条核对文本及次数。未知 warn/error 仍输出，且额外消息会使断言失败；没有重试隐藏失败。

Task4 曾在并发构建/预览时遇到 >2 MiB 拒绝请求的 `ECONNRESET`，当时随后 OAuth18/18、全量422/422均通过。Task5 首次最终全量在没有额外预览/构建时再次复现：427项中425通过，失败为该请求和父用例，36314.2353ms；异常位于 Miniflare.dispatchFetch→undici 上传，尚未取得413。检查生产限流逻辑及 Miniflare 转发代码后，将超大请求构造移到 test-only workerd fixture，仍调用相同生产 app.fetch/consent 端点，分别断言声明 >2 MiB 的 Content-Length 和无声明长度的64KiB分块流都返回413，并确认流式输入被提前取消。有效的2000画布大表单仍从真实HTTP代理上传成功。没有重试、捕获后忽略失败或放宽生产限制；最终427/427通过。现有 Vite >500 kB chunk 提示保留，未在此任务改变前端打包策略。

独立本地配置也已按 [指南](mcp-setup.md#独立本地启动) 实测：七个本地迁移成功，HTTPS issuer 为 `https://localhost:8790`，合成账号登录200、新建画布201；服务随后停止。本地自签名证书请求仅在该冒烟命令使用跳过证书验证，真实四端应在可信HTTPS preview验收。

## 已知边界与设计裁决

| 决策                                                                           | 理由与代价                                                                                                             |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| 业务语义先由共享命令/查询实现，协议依赖固定官方 provider+SDK                   | 共用旧网页验证、作者及对象版本；版本兼容仍需每次升级重新测试，注册表最新版本不能替代兼容证据                           |
| 只提供九个 Tools；待办/文本段落都属便签 blocks                                 | 保持原数据模型；不扩展成画布布局、账号管理、图片或运维工具                                                             |
| `ungrouped` 严格表示持久化 `parentId=null`；读取 `section_id` 可为 null         | 根便签返回 `ungrouped`；存在灵感板祖先时保留其 ID；直接收纳且无灵感板祖先时返回 null，并保留 `parent_id`、`archived`、`locked`。搜索和详情一致，写入目标合同不变 |
| 权限每次取 token scope ∩ active D1 grant ∩ 显式画布选择 ∩ 当前成员             | token 有效不等于业务授权有效；写入前在 DO 再查，付出 D1 查询成本以即时撤权                                             |
| D1 全局 grant/request 绑定 + DO 原子成功回执                                   | D1 负责跨画布仲裁，预留不是成功；断交后原参数重试可继续，绑定与成功回执不自动清理，会持续占用存储                      |
| pending→provider 签发→D1 active，替换旧 grant 与激活同批                       | 两种存储无分布式事务；中断一律 fail closed。同客户端/资源重授权可能让其他设备重新连接                                  |
| consent GET 绑定账号/会话；10 分钟内 POST 一次；精确 `/mcp/consent?handle=...` | 阻止展示后切换账号与旧表单重放；最终 SPA 文档设置防嵌入/referrer/no-store；回调仅取官方服务端结果                      |
| 每次认证 consent 机会清理最多 100 条过期临时 D1 生命周期                       | 到期即时拒绝使用，物理删除可等下次同意；闲置环境可留过期 metadata，不增加定时器/队列/新 DO                             |
| provider 关联/孤立扫描最多 10×100；撤销后的 provider 清理 best-effort          | D1 始终 fail closed；超过关联界限或 provider 故障需重新授权/运维排查，无后台重试队列                                   |
| 业务分页结果 ≤256000 UTF-8 字节；指定单 task 完整结果 ≤1 MiB                   | 大内容减小每页项数或提示指定 task；SDK 同时返回文本 JSON 与 structuredContent，整个 MCP wire envelope 可大于业务页上限 |
| 删除快照 30 天、原操作用户可在 grant 撤销后恢复                                | 不替换后续内容；旧不可变网页/MCP 成功回执可能继续包含历史内容，30 天不承诺所有历史数据物理删除                         |
| 功能默认关闭，管理/恢复独立于 MCP 开关                                         | 紧急停用保留正常网页、撤销和恢复；OAuth KV/D1/DO/资源 origin 在 production/preview/local 分隔                          |
| 本地分支交付；先 D1 后代码、preview 先于生产、由维护者手动发布                 | 本地 dry-run 不能证明云端权限/资源/真实客户端；本次没有 push、merge 或部署                                             |

本地 CIMD fixture 证明官方解析、大小限制与缓存路径，**未验证**真实公网 DNS/私网 IP 阻断、客户端真实元数据域名和回调；这些依赖 `global_fetch_strictly_public` 及实际 HTTPS 环境。访问 token 的 900 秒颁发值已断言，未实等 15 分钟观察自然失效；人工预览验收应包括真实时间刷新/到期。合成 UI 视觉检查已由控制端在 1280×720 检查 consent→home、profile/revoke、撤销后 history/recovery；截图仅为界面证据，不是任何外部客户端验收。

本次交付环境的本地冒烟服务已停止。自动审批拒绝了可选的递归清理命令（`blocked by policy`），因此合成数据目录 `D:/TODO/qingdan-canvas/.tmp/mcp-local-verify-a3e0c24b91d744b2b5cef75c73b9ff24` 保留在 Git 忽略范围内；没有绕过审批、触碰开发/远程数据或把该目录提交到分支。

## 四端与发布待验收

流程上的实施选择也保留在此：用户已明确要求“开始构建”，因此没有重复等待方案批准；所有修改均可在 Git 功能分支审阅。原生 worktree 创建因聊天目录是仓库父目录而失败，改用干净的 `feat/qingdan-mcp` 分支，未并行安排代码实施者；代价是没有额外的目录级隔离。实现与审查按任务顺序委派，以覆盖授权和并发风险，代价是额外审查时间。纯业务语义先于存储/协议实现，密码变更和重设的 D1 撤权提前到存储任务完成，以便与凭据修改保持原子性；最终跨层测试验证了组合后的行为。

本次只交付本地分支，不默认推送、合并或发布。实现中的范围、生命周期和输出大小裁决已列在上表；真实部署与四客户端验收仍需维护者按下列清单完成。

| 客户端                 | 本机只读证据                                                                                       | OAuth / 九工具 / 网页同步 / 重连 / 撤销       |
| ---------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Codex                  | `codex-cli 0.164.0-alpha.11.1`；add/login help 确认 HTTP URL、resource、scopes、auto/cimd/dcr 参数 | 未运行：需要部署 preview 与用户登录           |
| Claude Code            | PATH 无 `claude`；接入命令核对官方文档                                                             | 未运行：需安装、登录及部署 preview            |
| VS Code GitHub Copilot | VS Code `1.143.1`，commit `e646868227c3e3a9e3f24277c8c7220be42c0be7`，x64；未验证 Copilot          | 未运行：需要 Copilot 环境、preview 与用户登录 |
| Cursor                 | `3.18.9`，commit `2ba48ff3f7514cc4643c52ca9f7b3173d9b66130`，x64                                   | 未运行：需要部署 preview 与用户登录           |

客户端说明于 2026-10-27 核对 [OpenAI 官方文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)、[Claude Code 官方文档](https://code.claude.com/docs/en/mcp)、[VS Code 官方文档](https://code.visualstudio.com/docs/agent-customization/mcp-servers)、[Cursor 官方文档](https://cursor.com/docs/mcp)；这不是四端连接成功的记录。

- [ ] 专用 preview KV/origin/绑定和远程 D1 追加迁移核实，使用 Wrangler `previews` 发布。
- [ ] 四个客户端分别按 [流程](mcp-setup.md#四端共用验收步骤) 跑授权、查读写、网页观察、重连、撤销；记录真实版本、协议和结果，包含实际 CIMD/DCR 与回调互通。
- [ ] 真实 HTTPS 域名/Origin/回调、安全浏览器 Cookie、15 分钟 token 和绝对 grant 期限验证。
- [ ] 生产 D1 迁移后手动发布；生产 `APP_ENV=production`，专用画布冒烟。
- [ ] 开关停用、D1 撤权、兼容代码回滚与保留新增表/回执的演练。
