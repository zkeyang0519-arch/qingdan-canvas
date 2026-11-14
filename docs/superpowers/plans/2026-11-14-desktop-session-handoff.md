# Desktop Session Handoff Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development; implement the launcher/API, native receiver and renderer in separate file scopes, then run isolated integration verification.

**Goal:** 网页点击一次，桌面直接显示当前账号、当前画布的胶囊，无需再次登录或选择画布。

**Architecture:** 本机 API 验证 Cookie 对应账号和画布访问权，仅接收 roomId。共享启动器建立短时一次性回环交接服务，内存保存已验证的 qd_session；通过子进程 stdin 传递非公开描述符，Electron 单实例 additionalData 转发到原窗口。主进程领取并再次校验身份/画布，保存旧页后设置固定 session Cookie、进入固定画布 URL，等待 renderer 确认后回执。密钥不进入命令行、环境变量、普通日志或交接文件，也不暴露给 renderer。

**Tech Stack:** React、Node.js 24+、Electron 45.3.2，npm。

**Spec:** 本文是本次交互简化的设计；延续桌面灵动岛既有同步、草稿和单实例约束。

## Constraints

- D:/TODO/qingdan-canvas 原 Agent 分支；保留所有既有改动，不部署。
- 仅现有本机来源；不接受外部 URL、命令、profile、客户端传入 Cookie 或账号。
- 描述符为 `{version:1,endpoint:"http://127.0.0.1:<random>",nonce:<64hex>}`，通过 `--qingdan-desktop-handoff` 标识的 stdin 读取，严格大小和超时限制。
- 交接服务只允许精确 Host、无浏览器 Origin、POST、Bearer nonce：`/claim` 单次领取 `{accountId,roomId,sessionToken}`；`/check` 在确认之后、改 Cookie 之前验证交接仍有效；`/result` 回执 `{applied:true}` 或无秘密的固定错误。服务到期和完成都销毁。
- 同账号同画布只唤起，不重新加载、不丢输入；不同上下文先保存，未提交/未同步按既有默认取消流程处理。取消和保存失败保持旧 Cookie 和页面。
- 冷启从小胶囊开始，加载中不闪现完整登录页或画布列表；用户主动返回列表仍可使用原流程。
- 每个上下文的请求独立，不能用旧请求的成功回包回应另一账号/画布。浏览器账号和画布变化都取消本页等待并忽略旧回包。
- 原始 qd_session 只交给主进程 Cookie API，保留 HttpOnly、SameSite=Lax、固定本机 host/path；不延长服务器会话有效期。
- 旧主进程不支持新协议时不能假报成功或强杀；需一次通过旧版保存流程的安全退出升级。

## Tasks

- [x] API、短时交接服务及启动器：认证/成员权/来源/参数测试，单次领取、超时清理、上下文隔离、失败回执。
- [x] Native：stdin 协议、单实例转发、主进程二次验证与 Cookie 交接、保存/取消、同页无刷新、可信上下文回执。
- [x] Renderer：按钮携带画布、上下文变化隔离、小胶囊加载态、公开上下文报告。
- [x] 隔离原生验收21项与独立审查；npm test（1539/1539）、npm run check、npm run deploy:check。
- [x] 更新说明，安全载入本机服务并核对原有设备身份。
- [x] 用户已从托盘退出旧桌面；已核对旧进程退出、本机服务正常就绪，网页按钮可启动新版交接流程。
