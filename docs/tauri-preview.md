# 轻岛 Tauri 验证版

本目录是 **独立验证版本，尚未达到正式替代 Electron 的验收条件**。当前版本 `0.4.0-preview.2`，应用标识 `cn.zky.qingdao.preview`；现有 Electron 打包、更新源、登录与草稿目录不被替换。

第二版已实测 Windows WebView2 的账号交接、真实 Worker / WebSocket 同步、同画布保留输入、重启恢复、跨账号失败回退、断网编辑恢复同步及备份导入。Windows x64、Mac Apple Silicon 和 Intel 构建与原生测试均已通过。Mac 实机、正式签名更新、断网首次加载等门槛仍需完成，不能称为功能体验完全等价。

## 启动与构建

前置环境：Node.js 24+、Rust stable。Windows 还需要 Visual Studio Build Tools 的「使用 C++ 的桌面开发」和 Windows SDK；macOS 需要 Xcode Command Line Tools。

```sh
npm ci
npm run tauri:dev
npm run tauri:build -- --bundles nsis
```

macOS 构建：

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run tauri:build -- --target aarch64-apple-darwin --bundles dmg
npm run tauri:build -- --target x86_64-apple-darwin --bundles dmg
```

产物位于 `src-tauri/target/[target/]/release/bundle/`。`tauri-preview.yml` 支持手动触发，以及现有开发分支的 Tauri 文件变更触发，构建 Windows x64、Mac Apple Silicon 和 Mac Intel，仅上传验证产物，不创建正式 Release。Windows 复用 WebView2，缺失时由安装器联网补装；Mac 复用 WKWebView。当前未配置发行签名或 Mac 公证，不通过降低系统保护来启动。

本机工具的局部安装位于 `.tmp/tauri-tools`，`scripts/tauri.mjs` 自动识别其中的 Rust；其余机器使用 PATH 中的 Rust。先执行 `node scripts/build-tauri.mjs` 后可运行 `npm run tauri:check`。

## 验证流程

首次打开进入真实轻单登录页；成功进入画布后保存上次画布，重启时恢复，登录由验证版独立 WebView 会话保存。托盘「返回本地验证画布」仍可打开隔离演示，演示内容不写入线上账号。

1. 展开和收起，检查首条待办摘要、全部待办列表、小动物、钉住、输入框。
2. 拖动到顶部、左侧、右侧；检查鼠标释放、侧签展开和未提交输入。
3. 将其他软件放在下方，点击双舱间隙；检查穿透，再返回胶囊检查悬停能否恢复。
4. 在不同缩放、多屏、拔掉外屏后复验；Mac 另测菜单栏、Dock、Spaces、全屏应用。
5. 隐藏后从托盘「显示轻岛」恢复；退出后重开，确认位置、待办和输入恢复。
6. 托盘「登录真实轻单」进入线上 `/app`，使用验证版独立会话，测试同步、锁定、网络中断和草稿保存。此模式加载线上界面，**不会把本地未发布前端当成线上已发布版本**。

开发时可通过 `QINGDAO_PREVIEW_URL=http://127.0.0.1:5178/app` 指向已运行的本地前端（也支持 8788、8790）。不要使用生产账号做故障注入。

## 网页会话交接

Rust `online.rs` 移植既有的本机 challenge/verifier 协议，校验来源、Host、内容类型、大小、一次性请求、账号和画布，并独立检查 `/api/session` 的身份/有效期及画布访问权限。会话令牌通过原生 Cookie API 设置为 HttpOnly，不通过 URL、命令行或前端桥接传递。收到画布身份及岛布局确认后才返回成功。

第二版固定绑定 **8792**，安装配置注册 **`qingdao-preview://open`**；Electron 的 8791 / `qingdao://` 保留。网页通过 `/app?desktop=tauri-preview` 选择测试入口，选择仅在该标签页保留；`?desktop=stable` 切回原版。测试入口失败不会转而打开原版。**`6249214` 已于 2026-11-16 合入 main，并经 Cloudflare 自动构建发布。** 安装协议配置已实现，但浏览器许可弹窗和安装后冷唤起还需验收。

统一下载页为 [下载轻岛](https://todo.zky.lol/download/)，无需登录即可查看轻量验证版与原版，并直接下载 Windows / Mac Apple Silicon / Mac Intel 对应安装包。文件继续由 GitHub Releases 分发；轻量版的版本详情见 [0.4.0-preview.2](https://github.com/zkeyang0519-arch/qingdan-canvas/releases/tag/qingdao-preview-v0.4.0-preview.2)。GitHub 预发布不替换正式版的 `/releases/latest`，也不进入 Electron 的正式更新源。

网页未检测到轻岛时提供统一的「下载轻岛（轻量版 / 原版）」入口。新标签页通过随机请求标识对应的同源 BroadcastChannel 把版本选择通知原画布，不传递账号或凭据；原画布保留页面和草稿，安装后连接对应程序。独立访问或浏览器不支持标签页消息时，下载页仍可直接下载，并提供带版本选择的「安装后打开轻单」入口。网页启动时在登录和画布路由改写前保存该选择。

同账号同画布交接刷新会话而不重载页面；跨账号先保存、关闭旧页面后再换 Cookie。新页面失败时恢复旧 Cookie 和 URL，避免旧页面继续使用新账号发起同步。草稿未保存则停止切换；状态查询和取消请求校验请求归属。

## 旧版资料迁移验证

先从旧版托盘保存退出。开发环境可用下面的导出工具读取**明确指定且未被占用**的 Electron 资料目录；它不会关闭正在运行的旧版、复制 Cookie 库或导出认证存储。

```powershell
node scripts/export-desktop-state.mjs --profile "D:\absolute\old-profile" --origin https://todo.zky.lol --account ACCOUNT_ID --output "D:\absolute\qingdao-backup.json"
```

原资料路径以原版的 `profile-location.json` 为准，不能猜测或新建一个空目录代替。此流程仍是开发验证工具，尚非面向普通用户的一键升级。

在 Tauri 版登录同一网站、同一账号，回到画布列表，再从托盘「导入旧版草稿」选取文件。备份包含按账号隔离的 IndexedDB 副本（含原始离线操作编号）、视图偏好、附件、未提交输入和停靠位置；**登录通过正常登录或会话交接恢复，不从备份复制凭据**。存在不同的目标草稿时拒绝覆盖；重复导入相同内容不重复创建。两种存储写入失败会撤销本轮新增输入，IndexedDB 使用单事务。备份含私人待办内容，应由用户自行保管。

## 签名更新

第二版已实现检查、下载验签、通知现有界面、保存后安装及失败恢复；Windows 安装器和 Mac 重启路径分别处理。检查可从托盘发起，也每小时在后台执行。发布者需在 `src-tauri/updater-channel.json` 配置 HTTPS 更新地址和公钥，再生成带版本签名的更新包。当前两项为空，因此显示「尚未配置签名更新源」，不会误用 Electron 的更新源。签名发布、实际安装重启和 Mac 公证仍待验收；不要把代码接入当成发布链路已通过。

## 实现边界与正式替换前的门槛

| 项目 | 当前实现 / 待验收 |
| --- | --- |
| React 待办与同步代码 | 复用既有代码；验证画布为隔离本地数据 |
| 桌面接口 | 复用 `qingdanDesktop` v1 合约，几何算法与 Electron 共用 |
| 双舱穿透 | Windows 改为 Win32 窗口区域裁剪；Mac 保留原生指针轮询。真实跨应用鼠标操作仍需验收 |
| 托盘、置顶、隐藏、恢复 | Windows 原生程序已启动，隐藏命令与单实例唤起请求成功；托盘菜单、置顶与真实跨应用交互仍需人工验收 |
| 多屏和 DPI | 使用显示器工作区和物理/逻辑换算，监听 DPI 并检查显示器工作区变更；需混合缩放、拔屏及休眠实测 |
| 退出、切换前保存 | 请求前端保存并等待确认；未持久化内容阻止退出/切换 |
| 登录交接 | 独立测试入口；已用本地隔离 Worker 和实际 WebView2 验证成功交接、同账号复用、跨账号成功切换和失败回退 |
| 本地打包网页 | 验证画布随包分发；真实账号模式当前加载线上网页，尚未实现 Electron 同源离线资源拦截的等价方案 |
| 自动更新 | 验签及保存安装代码已接入；更新源/公钥未配置，实际发布安装待验收 |
| 旧版登录和草稿迁移 | 已有便携备份导出/导入；实际 Electron 导出和 WebView2 导入分别通过，普通用户一键迁移尚未实现 |
| 重启恢复上次真实画布 | 已实现并在实际进程保存退出、重启后验证账号、画布及未提交输入恢复 |
| macOS | Apple Silicon / Intel 均已在对应 Mac 云端环境成功编译、打包 DMG，通过 33 项桌面测试和 6 项原生测试；签名、公证和实机效果仍待验收 |

## 第一版记录：0.4.0-preview.1（2026-11-15）

- Tauri 前端产物构建通过；同时包含现有 app 和隔离验证画布。
- `npm run check` 通过。
- `npm run deploy:check` 通过（仅 dry-run，未部署）。
- 桌面相关测试共 178 项全部通过（包含新增接口测试 4 项）。首次沙箱运行因回环连接 `EACCES` 失败，允许本机回环连接后通过。
- 全仓 `npm test` 在允许回环连接后 1650 项全部通过，用时约 197 秒。首次受限运行失败后已停止；日志分别在 `.tmp/tauri-full-test-unrestricted.log`、`.tmp/tauri-desktop-test-unrestricted.log`。
- 加入验证画布回归测试后的最终全仓运行：1651 项，1648 通过，2 失败、1 超时取消；三项均为 Agent/Runner 恢复场景等待超时，当时同时进行 Rust 发布测试编译。日志 `.tmp/tauri-full-test-final.log`；不将此前 1650 全通过当作这次全仓全绿的证明。
- 停止编译负载后串行重跑涉及的三个文件，7 项全部通过（约 53 秒，`.tmp/tauri-final-retry.log`）。这支持资源竞争导致超时的判断，但未宣称最终全仓首次运行全绿。
- 上述 JavaScript 测试不包含 Rust 原生编译、原生窗口交互或 macOS 实机验收。
- 经用户确认后微软 C++ Build Tools / Windows SDK 安装成功，退出码 0。
- `npm run tauri:check`、发布构建、NSIS 打包均通过；`cargo test --release --locked --manifest-path src-tauri/Cargo.toml` 两项原生测试通过。
- 实机发现并修复了独立验证画布顶部偏移、缺失完成/恢复接口、恢复的输入在再次退出时被覆盖的问题；新增 `tests/tauri-preview-ui.test.mjs` 直接加载验证入口测试。
- Windows 本机实际 WebView2：157.0.4341.46，当前显示器工作区 1920 × 1032，缩放 100%。
- 实际应用 WebView 内验证：顶部展开/收起、完成/恢复、新增待办、输入持久化、进程重启恢复、原生右侧停靠位置恢复、左右展开布局。左右停靠通过调用保存位置并重载触发，**不等同于实际鼠标拖拽验证**。
- computer-use 与 CUA 的 JS 内核均因 `failed to write kernel assets` 无法启动；因此使用独立应用的本机 CDP 调试接口验证。未验证真实鼠标跨应用穿透、托盘点击、全屏置顶或混合 DPI；不能由 WebView 截图推导这些行为已通过。
- 最终 Windows NSIS 包：**13,518,163 字节，13.52 MB / 12.89 MiB**。此前本地 Electron 0.3.2 包为 132,874,335 字节，当前包缩小约 89.83%。此比较为验证版当前功能范围，不是完整迁移后的最终承诺。
- Windows 包复用系统已有 WebView2；若没有运行环境，还需联网下载。应用数据和共享运行环境占用不包含在安装包大小中。
- 产物及截图复制至 `output/tauri-preview/`。Mac 仅准备构建配置，尚无构建结果或实机验收记录。
- 交付文件：`Qingdao-Preview-0.4.0-preview.1-x64-Setup.exe`（安装包）、`Qingdao-Preview.exe`（免安装程序），SHA-256 见同目录 `artifacts.json`。普通验证程序已启动，调试端口已关闭，原 Electron 仍在运行。

官方参考：[Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/)、[Windows installer](https://v2.tauri.app/distribute/windows-installer/)、[Window APIs](https://v2.tauri.app/reference/javascript/api/namespacewindow/)、[Updater](https://v2.tauri.app/plugin/updater/)。

## 第二版原生验收：0.4.0-preview.2

隔离服务 `tests/fixtures/tauri-acceptance-server.mjs` 运行真实 Worker、D1、R2、SQLite DO 和当前 React 前端，使用专用端口 **18788** 和虚拟账号 Alice / Bob。原生验收标识为 `cn.zky.qingdao.acceptance`，资料目录由脚本新建；不会读取用户的原版或普通验证版资料。

`scripts/test-tauri-native.mjs` 通过实际 WebView2 CDP 完成：

- 原生授权交接、身份/画布确认、HttpOnly Cookie、一次性请求和状态归属。
- 新增、完成和恢复待办经真实 WebSocket / DO 同步，独立 HTTP 快照确认。
- 已打开的真实画布断网后仍可新增；关闭连接并模拟离线期间，服务端快照保持不变；恢复网络后新增内容同步成功。这不代表离线冷启动已支持。
- 同账号同画布交接保持原页面及未提交输入。
- 保存退出进程后重新启动，恢复 Cookie、上次画布和输入草稿。
- 故意让账号 B 页面加载失败，确认恢复账号 A 的 Cookie 和画布；之后可正常切换 B。
- 模拟本机保存失败，确认原生退出被拒绝。
- 真实 IndexedDB / localStorage 导入、重复导入幂等及进入画布后的输入恢复。

另外用隔离 Electron 资料目录实际运行导出器，确认离线操作、输入、附件和位置存在，非白名单认证存储未被导出。修复了 WebView2 IPC 仅传 Origin 导致路径级权限匹配失败，以及 Electron 启动器将独立参数值误判为另一个入口的问题。

验收仅在 Windows 100% 缩放单屏完成。截图证明渲染，不证明鼠标拖动、跨应用穿透、全屏置顶、托盘点击、混合 DPI 或 Mac 行为。源文件可用下列命令复验；`test-harness` **不得用于分发包**：

```powershell
# 配置文件需指定独立标识 cn.zky.qingdao.acceptance
npm run tauri:build -- --features test-harness --no-bundle --config .tmp/tauri-harness.conf.json
node tests/fixtures/tauri-acceptance-server.mjs
# 在另一个终端运行，传入上述测试构建的程序路径
node scripts/test-tauri-native.mjs "D:\absolute\Qingdao-Acceptance.exe"
```

分发包使用默认 feature 构建，不接受验收服务器的授权来源，也没有测试退出接口。最新测试记录和安装包见 `output/tauri-preview2/`。

本机 Windows 发布构建和 NSIS 打包通过，原生 Rust 测试 **6/6**、类型检查及部署 dry-run 通过。本地工作区全仓 `npm test` **1655/1655** 通过（153 秒，无失败或取消）；日志 `.tmp/tauri-preview2-full-test.log`。本轮保留了既有 Agent 测试修复，未将那些无关修改纳入迁移提交。安装包 **13,730,663 字节（13.73 MB / 13.09 MiB）**，独立程序 17,994,752 字节；SHA-256 记录在产物目录。系统 WebView2 和应用资料占用不包含在安装包体积内。

[三平台云端构建记录](https://github.com/zkeyang0519-arch/qingdan-canvas/actions/runs/43728356029) 对应源码 `c6ebe5e`：Windows x64、Mac Apple Silicon、Mac Intel 各通过类型检查、33 项桌面 JavaScript 测试和 6 项 Rust 测试，并上传 NSIS / DMG。Mac 使用 `macos-15` 与 `macos-15-intel` 原生架构环境。之后的验收脚本、记录与网页下载入口更新未重建上述原生安装包。

第二版交付目录为 `output/tauri-preview2/`：

| 平台 | 安装包 | 字节 | MB | MiB |
| --- | --- | ---: | ---: | ---: |
| Windows x64 | `Qingdao-Preview-0.4.0-preview.2-x64-Setup.exe` | 13,730,663 | 13.73 | 13.09 |
| Mac Apple Silicon | `Qingdao-Preview-0.4.0-preview.2-mac-AppleSilicon.dmg` | 14,317,815 | 14.32 | 13.65 |
| Mac Intel | `Qingdao-Preview-0.4.0-preview.2-mac-Intel.dmg` | 14,427,135 | 14.43 | 13.76 |

Mac 下载归档已与 GitHub Artifact 的 SHA-256 一致性校验；解压后各安装包的 SHA-256 见同目录 `artifacts.json`。Windows 相比此前 132,874,335 字节的 Electron 0.3.2 安装包缩小约 **89.67%**，此结果只代表当前验证版。`native-account.png` 为 Windows 实际 WebView2 截图，`native-acceptance.json` 记录 9 组原生验收结果。所有验收辅助程序及调试端口已退出；未安装第二版覆盖用户现有应用。

三平台构建完成时只上传了验证产物。后续已合入 main 并由 Cloudflare 自动部署网页，三个安装包另行发布到明确标注 Pre-release 的验证版 Release。自动更新签名、公证、一键迁移、线上按钮冷唤起、离线冷启动，以及 Mac / 多屏实机交互仍是正式替换前的验收项目。
