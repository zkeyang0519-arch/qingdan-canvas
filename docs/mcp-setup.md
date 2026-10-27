# 轻单 MCP 接入指南

统一连接地址为 `https://<你的域名>/mcp`，使用 Streamable HTTP 与 OAuth。请先由站点维护者按 [环境配置](mcp-configuration.md) 和 [Cloudflare 发布说明](cloudflare-setup.md#轻单-mcp-升级与发布) 部署独立 preview。下面是供用户手动执行的说明，本次没有修改任何客户端配置、登录真实账号或部署云端。

## 授权与权限

连接时会打开轻单登录/授权页面。确认账号、客户端实际 ID、回调域名，逐个勾选画布，再选择只读或读写；不需要长期刷新时取消持续连接。未勾选、以后新增的画布不会自动开放。客户端显示名可能未经验证；应核对域名和实际 ID。登录 Cookie 不能代替 MCP Bearer token。

只读允许 `list_canvases`、`get_canvas`、`search_content`、`get_content`。读写另外允许 `create_tasks`、`update_task`、`delete_task`、`create_note`、`update_note`。待办和便签段落共用权限，不能只授权其中一种。读取最新便签 revision 后再修改；同一便签的并发变化会返回 `REVISION_CONFLICT`，需要重新读取并决定下一步，不能盲目重试旧 revision。网络中断后，以原 request_id 和原参数重试可取回原成功结果；改变参数时必须换 ID。

访问 token 最多 15 分钟，授权绝对期限最多 30 天；仅选择 `offline_access` 才有刷新 token。到期、撤销、修改或重设密码后需要重新授权。普通退出网页登录不撤销已有 MCP 连接。同账号/同客户端/同资源重新授权会替换旧授权，使用同客户端 ID 的其他设备也可能需要重连。

## Codex

本机检查版本为 `codex-cli 0.164.0-alpha.11.1`。下列命令由本机 `codex mcp add --help`、`codex mcp login --help` 及 [OpenAI 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) 核对；未执行添加或登录。

```powershell
codex mcp add qingdan-preview --url "https://<PREVIEW_HOST>/mcp" --oauth-resource "https://<PREVIEW_HOST>/mcp"
codex mcp login qingdan-preview --scopes "qingdan:read,offline_access"
codex mcp list
```

需要读写时将登录 scopes 改成 `qingdan:read,qingdan:write,offline_access`，仍需在轻单页面确认。默认注册方式为 auto；排查注册互通时，可在本次 login 增加 `--oauth-client-registration dcr` 或 `--oauth-client-registration cimd` 分别记录结果。该选项只影响本次登录，不能据本地模拟结果断言实际 Codex CIMD 已接通。TUI 用 `/mcp` 检查工具；重连时重新运行 login。删除本机条目用 `codex mcp remove qingdan-preview`；服务端撤权请在轻单网页操作。

## Claude Code

本机 PATH 未发现 Claude CLI；本段依据 [Claude Code 官方文档](https://code.claude.com/docs/en/mcp)，需要先安装并登录 Claude Code。

```powershell
claude mcp add --transport http --scope user qingdan-preview "https://<PREVIEW_HOST>/mcp"
claude mcp list
```

打开 Claude Code，运行 `/mcp`，选择轻单完成浏览器 OAuth，并检查九工具。`--scope user` 保存为个人跨项目配置；团队项目配置请另行选择 project scope。连接异常时在 `/mcp` 菜单选择 Reconnect；切换账号或重新授权前可选 Clear authentication，再启动授权。移除个人条目可运行 `claude mcp remove --scope user qingdan-preview`。客户端清理凭据后仍应到轻单网页核实授权已撤销。

## VS Code 的 GitHub Copilot

本机 VS Code 为 `1.143.1`（x64）；未验证 Copilot 扩展、账号和连接。按 [VS Code 官方接入流程](https://code.visualstudio.com/docs/agent-customization/mcp-servers)：打开命令面板 → **MCP: Add Server** → **HTTP**，输入完整 `/mcp` 地址，命名 `qingdan-preview`；个人配置选择 **Global → Copilot Global**。若没有该选项，先确认使用的是原生 Copilot harness 及其账号环境。

项目内的原生 VS Code 配置示例为 `.vscode/mcp.json`：

```json
{
  "servers": {
    "qingdan-preview": { "type": "http", "url": "https://<PREVIEW_HOST>/mcp" }
  }
}
```

按信任和身份验证提示打开轻单授权，在 Copilot Chat 的 Agent 会话工具选择器中启用该服务器，明确请求一次 `list_canvases` 并查看实际工具调用。配置文件保存成功不代表连接成功。重连可从 MCP 服务器管理中停止/启动服务，遇到认证要求时重新授权；移除配置前先在轻单撤销连接。不同 harness 的配置目的地和工具可见性可能不同。

## Cursor

本机 Cursor 为 `3.18.9`（x64），未连接。按 [Cursor 官方 MCP 文档](https://cursor.com/docs/mcp)，在项目 `.cursor/mcp.json` 或个人 `~/.cursor/mcp.json`（Windows 为 `%USERPROFILE%\.cursor\mcp.json`）合并以下条目，保留其他服务器：

```json
{
  "mcpServers": {
    "qingdan-preview": { "url": "https://<PREVIEW_HOST>/mcp" }
  }
}
```

在 Customize/MCP 的服务器列表完成 OAuth，启用服务器并在 Agent 中查看实际九工具。连接异常时从该列表重新连接；必要时禁用后重新启用/重启 Cursor，并按提示重新授权。轻单支持动态注册，示例无需预填客户端 secret 或粘贴 Bearer token。正式验收需记录客户端实际采用的回调地址和协议版本，不能由此配置示例推断。

## 四端共用验收步骤

使用 preview 的两个测试账号和专用测试画布；每个客户端分别记录版本、时间、URL、协商协议、授权档位和结果，填入 [验收记录](mcp-acceptance.md#四端与发布待验收)。

1. 先授权账号 A 的一张画布为只读。要求 agent 实际调用列画布、搜索及读取工具；验证未授权画布和账号 B 私有画布不可访问，写入被拒绝。
2. 重新授权读写。让 agent 创建一项标记为“该客户端名称+时间”的待办，读取它，编辑便签、日期、备注与引用；在网页同时观察内容、作者和版本变化。保留 tool 名与结果状态，避免记录 token、Cookie、授权码和完整 callback URL。
3. 网页和 agent 同时改同一便签，验证冲突可解释；模拟调用响应丢失，用相同 request_id/参数重试，确认 ID、时间、revision 不变。
4. 关闭再打开客户端，验证重新连接/刷新；在网页账号设置 → **Agent 连接** 撤销，验证旧连接下一次调用失败，重新授权后才恢复。修改/重设密码后也应失败。
5. agent 删除一段，网页做后续编辑并撤销 grant，在同一面板的操作记录中恢复删除，确认后续编辑保留。恢复只允许原操作用户、当前成员，窗口为 30 天，与 grant 是否仍有效无关。

所有四端实际结果目前均为 **未运行：需要已部署 preview 与用户登录**。

## 独立本地启动

自动验收会自行创建/清理独立 workerd、D1、KV、DO，最快复现方式：

```powershell
node --test tests/mcp-oauth.test.mjs tests/mcp-storage.test.mjs tests/mcp-domain.test.mjs tests/mcp-ui.test.mjs
```

需要停留在本地浏览器调试时，从仓库根目录执行以下命令。使用专用 [本地配置](mcp-local.example.jsonc)，只包含本地占位 ID；不要把它用于云端发布，也不要改用普通开发数据目录。

```powershell
$mcpRun = Join-Path (Get-Location) (".tmp/mcp-local-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $mcpRun | Out-Null
npm run build
npx wrangler d1 migrations apply qingdan-mcp-local --local --config docs/mcp-local.example.jsonc --persist-to $mcpRun
$mcpHash = node --input-type=module -e "import {hashPassword} from './worker/passwords.js'; console.log(await hashPassword('Local-mcp-test-2026'))"
$mcpSeed = Join-Path $mcpRun "synthetic-account.sql"
"INSERT INTO accounts(id,username,name,password_hash,created_at) VALUES('local-mcp','local_mcp','本地测试','$mcpHash','2026-10-27');" | Set-Content -Encoding utf8 $mcpSeed
npx wrangler d1 execute qingdan-mcp-local --local --config docs/mcp-local.example.jsonc --persist-to $mcpRun --file $mcpSeed
npx wrangler dev --local --config docs/mcp-local.example.jsonc --persist-to $mcpRun --ip 127.0.0.1 --port 8790 --local-protocol https --inspector-port 0
```

在 `https://localhost:8790` 使用合成账号 `local_mcp` / `Local-mcp-test-2026` 登录并新建画布；这些公开示例凭据只限新的本地隔离目录。浏览器需要信任 Wrangler 的本地 HTTPS 证书；所有 MCP origin/resource 必须保持 `https://localhost:8790`。客户端若不接受自签名证书，使用部署好的 HTTPS preview 完成人工联调。本地配置没有发信凭据，新账号注册/找回邮件不可用。停止终端即停止本地服务；目录路径记录在 `$mcpRun`，与开发 `.wrangler` 状态相互独立。

## 常见问题

| 现象                                   | 检查/操作                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------- |
| 404 `MCP is not configured`            | 维护者检查该环境的开关、固定 PUBLIC_ORIGIN 和专用 OAUTH_KV，见 [配置](mcp-configuration.md) |
| 401 / invalid_token                    | 已到期、撤销或密码变更；从客户端重新授权，不能复用网页 Cookie                               |
| 403 scope challenge                    | 在轻单重新授权读写；配置请求 scopes 不会跳过用户同意                                        |
| `ACCESS_DENIED`                        | 当前成员身份与本次勾选画布必须同时满足，检查正在使用的轻单账号                              |
| `REVISION_CONFLICT` / `STALE_CURSOR`   | 重新读取最新内容/从第一页重新搜索，再由用户或 agent 决定修改                                |
| 重复授权、过期页面、账号切换后提交失败 | 从客户端重启 OAuth；授权表单 10 分钟有效，不可复用旧 handle                                 |
| 恢复入口不可用                         | 检查原操作用户、当前成员、30 天窗口、锁定/收纳祖先及目标是否还存在                          |
