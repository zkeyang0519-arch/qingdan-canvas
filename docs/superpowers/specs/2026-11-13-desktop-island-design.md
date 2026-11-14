# 轻单桌面灵动岛

用户要求在其他软件前台时仍能显示和操作待办，继续在原 `D:/TODO/qingdan-canvas` / `feat/qingdan-mcp` 开发。原工作区未提交改动保留，不自动提交或部署。

## 方案

采用 Electron 45.3.2 的独立透明置顶窗，复用现有 React 登录、画布选择、DynamicIsland、useRoomWorkspace 与同步回执。实现选择由开发者负责。浏览器画中画依赖浏览器且窗口控制有限；Rust/WebView2 能减小体积但增加另一套工具链。Electron 与现有 npm/React 最容易直接复用。

原 `npm run dev` 保持不变，新增 `npm run desktop` 连接已运行的 `http://127.0.0.1:8790/app`；不重复启动、不停止 Runner。服务缺失时显示明确的启动/重试指引。桌面与浏览器拥有独立登录会话，首次登录同一账号后操作同一画布数据。

## 行为

- 登录/选画布使用较大窗口；进入画布后自动成为顶部胶囊。切换其他普通软件仍置顶，悬停/点击展开，支持钉住、勾选、新增、项目切换。
- 有明确拖动区域；窗口随收展调整大小，透明空白不拦截底下应用操作；位置限制在显示器工作区域，多屏变更后可恢复。
- 面板可返回画布选择、在浏览器打开当前画布、隐藏到托盘。托盘可显示、重置位置和退出。关闭窗口只隐藏，重复启动恢复原窗口。
- 退出前等待本地保存；保存失败不得静默退出；存在未同步内容或未提交输入时明确提示。桌面同步草稿使用稳定身份，保留现有身份锁、账号/画布隔离和对象版本/回执。
- 桌面保留错误重试、备份和冲突处理入口。普通网页不进入桌面模式，不依靠易丢失的 query 参数：只有受限 preload bridge 存在才启用桌面 UI。

## 边界与接口

- `window.qingdanDesktop`：`version:1`；`setLayout({mode:'setup'|'island',width,height})`；`hide()`；`openWorkspace(roomId)`；`onBeforeQuit(async()=>({unsynced,hasDraft}))` 返回注销函数。仅这些受限能力通过隔离 preload 提供。主进程核验 sender、主 frame 与应用 origin/path，拒绝外部导航、新窗口、权限和 renderer Node 权限。
- Electron userdata 默认放在忽略目录 `.tmp/desktop-profile`，测试使用独立目录和随机本地服务。单实例锁防止同一档案重复窗口。
- `useRoomWorkspace(room,user,{draftIdentity}={})` 新增可选固定身份及 `flushLocal()`，网页默认行为保持不变。
- `DynamicIsland` 添加可选桌面工具栏、关闭标签、窗口失焦收起和草稿状态通知。尺寸由桌面 wrapper 观察真实岛元素，桌面 CSS 不使用小窗口自身高度限制其展开内容。
- 不增加后端接口或数据库迁移；不注册开机启动、不自动操作真实账号或设备绑定。第一版交付源码启动入口，不承诺已签名安装包。

依据：[Electron 窗口接口](https://www.electronjs.org/docs/latest/api/base-window)、[自定义拖动区域](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions)、[安全隔离](https://www.electronjs.org/docs/latest/tutorial/security)。
