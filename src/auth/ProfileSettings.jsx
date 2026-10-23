import { useEffect, useRef, useState } from "react";
import { LogOut } from "lucide-react";
import { api, announceAccountChange } from "../api.js";
import UserAvatar from "../UserAvatar.jsx";
import EmailSettings from "./EmailSettings.jsx";
import AvatarCropper from "./AvatarCropper.jsx";

export default function ProfileSettings({ user, onUpdate, onLogout }) {
  const [name, setName] = useState(user.name);
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [avatarFile, setAvatarFile] = useState(null);
  const fileInput = useRef(null);
  const avatarToken = useRef(0);
  const mounted = useRef(false);
  const currentUser = useRef(user.id);
  currentUser.current = user.id;
  useEffect(() => {
    mounted.current = true;
    avatarToken.current++;
    setAvatarFile(null);
    setBusy(false);
    return () => {
      mounted.current = false;
    };
  }, [user.id]);
  async function act(event, action) {
    event?.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="profile-settings">
      <h2>账号设置</h2>
      <p>
        用户名：<strong>{user.username}</strong>
      </p>
      <div className="profile-avatar-setting">
        <UserAvatar
          userId={user.id}
          name={user.name}
          avatarVersion={user.avatarVersion}
          className="profile-avatar"
        />
        <div>
          <div className="profile-avatar-actions">
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              {user.avatarVersion ? "更换头像" : "上传头像"}
            </button>
            {user.avatarVersion && (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={(event) =>
                  act(event, async () => {
                    const result = await api("/api/profile/avatar", {
                      method: "DELETE",
                      accountId: user.id,
                    });
                    onUpdate(result);
                    announceAccountChange();
                    setNotice("头像已移除。");
                  })
                }
              >
                移除头像
              </button>
            )}
          </div>
          <small>
            PNG、JPEG、WebP、GIF，最大 5 MB
            <br />
            可调整圆形范围与原图缩放，GIF 使用静态画面。
          </small>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          aria-label="选择头像图片"
          hidden
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            setError("");
            setNotice("");
            setAvatarFile({
              file,
              accountId: user.id,
              token: ++avatarToken.current,
            });
          }}
        />
      </div>
      {avatarFile?.accountId === user.id && (
        <AvatarCropper
          key={avatarFile.token}
          file={avatarFile.file}
          onBusyChange={(value) => {
            if (
              mounted.current &&
              currentUser.current === avatarFile.accountId &&
              avatarToken.current === avatarFile.token
            )
              setBusy(value);
          }}
          onCancel={() => setAvatarFile(null)}
          onConfirm={async (rawBody) => {
            const result = await api("/api/profile/avatar", {
              method: "PUT",
              rawBody,
              accountId: avatarFile.accountId,
            });
            if (
              currentUser.current !== avatarFile.accountId ||
              avatarToken.current !== avatarFile.token
            )
              return;
            // The App guards account identity and session epoch even after this
            // dialog closes. A completed upload still needs to refresh its avatar.
            onUpdate(result);
            announceAccountChange();
            if (mounted.current) {
              setAvatarFile(null);
              setNotice("头像已保存。");
            }
          }}
        />
      )}
      <form
        onSubmit={(event) =>
          act(event, async () => {
            const result = await api("/api/session", {
              method: "POST",
              body: { name },
            });
            onUpdate(result);
            announceAccountChange();
            setNotice("昵称已保存。");
          })
        }
      >
        <label>
          昵称
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={32}
            required
          />
        </label>
        <button className="secondary wide" disabled={busy}>
          保存昵称
        </button>
      </form>
      <EmailSettings user={user} />
      <details>
        <summary>修改密码</summary>
        <form
          onSubmit={(event) =>
            act(event, async () => {
              if (password !== confirm)
                throw new Error("两次输入的新密码不一致。");
              const result = await api("/api/auth/password", {
                method: "POST",
                body: { currentPassword, password },
              });
              onUpdate(result);
              announceAccountChange();
              setCurrentPassword("");
              setPassword("");
              setConfirm("");
              setNotice("密码已更新，其他设备需要重新登录。");
            })
          }
        >
          <label>
            当前密码
            <input
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              maxLength={128}
              required
            />
          </label>
          <label>
            新密码
            <input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={9}
              maxLength={128}
              required
            />
          </label>
          <label>
            确认新密码
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              minLength={9}
              maxLength={128}
              required
            />
          </label>
          <button className="primary wide" disabled={busy}>
            更新密码
          </button>
        </form>
      </details>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="profile-notice" role="status">
          {notice}
        </p>
      )}
      <button
        type="button"
        className="secondary wide logout-button"
        disabled={busy}
        onClick={(event) => act(event, onLogout)}
      >
        <LogOut size={16} />
        退出登录
      </button>
    </div>
  );
}
