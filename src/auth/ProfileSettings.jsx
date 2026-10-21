import { useState } from "react";
import { LogOut } from "lucide-react";
import { api, announceAccountChange } from "../api.js";

export default function ProfileSettings({ user, onUpdate, onLogout }) {
  const [name, setName] = useState(user.name);
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
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
