# 轻单账号与个人空间

用户要求：访问网站后先注册/登录，画布及其中的灵感板内容按账号保存；已有邀请协作继续可用。默认采用用户名与密码，无额外邮件服务。

- 用户名为 3–32 位英文字母、数字、下划线或短横线，不区分大小写；昵称支持中文。密码 12–128 字符，不静默裁剪。
- 新增 D1 accounts、account_sessions、auth_limits、legacy_claims；保留旧 sessions 表以迁移访客。账号 ID 稳定，多设备各有独立随机会话，30 天有效。
- 登录前不返回画布列表、快照、文件或 WebSocket。注册账号后可直接创建画布，不再使用 CREATE_KEY。本人创建和受邀加入的画布显示在个人空间；灵感板作为画布内部内容沿用既有 DO 数据，不复制。
- 同浏览器有效旧访客可选择将原有已同步画布归入账号。注册承接旧 ID；登录已有账号时事务合并成员关系、转移 owner_id。仅持有有效旧 Cookie 可以迁移，legacy_claims 保证只认领一次。原画布、R2 文件、DO ID 与邀请不变。
- scrypt 随机盐哈希，N=16384/r=8/p=5（OWASP 列出的配置）；恒定时间比较。服务端 IP 与账号限流，通用登录错误，同源检查，HttpOnly/SameSite Cookie，线上 Secure。
- 退出立即吊销当前会话。修改密码验证旧密码、轮换当前会话、吊销所有旧会话。DO 在写入及广播前验证会话，过期或退出的连接不能继续收发内容；旧匿名连接同样失效。
- 前端登录、注册、个人设置独立组件。跨标签页账号变化触发重新校验并清空当前视图；重新连接前比对服务器身份，防止旧账号草稿作为新账号发送。邀请保留到登录成功后使用。
- 此版不包含邮箱验证/找回密码；忘记密码需要后续管理员恢复流程，界面明确说明。未同步访客草稿在注册承接同一 ID 时保留；登录已有账号仅迁移已同步数据。
- 验证：真实本地 Worker/D1/R2/DO 注册登录、不同设备持久化、非法跨账号请求、邀请、迁移、会话失效、密码修改、限流；浏览器注册/登录/退出及双栏视图。
- 云端数据库迁移和部署由用户手动完成。不会创建新 Cloudflare 产品或改动云端数据。

参考：[Cloudflare Node crypto](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/)、[OWASP 密码存储](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt)。安全密码哈希需要 CPU 时间；本地验证不代替上线时对 Worker 实际 CPU 配额的确认。
