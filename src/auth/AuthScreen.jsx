import { useState } from "react";
import { ArrowRight, LockKeyhole, LayoutDashboard, Users } from "lucide-react";
import { api, announceAccountChange } from "../api.js";
import ForgotPassword from "./ForgotPassword.jsx";

export default function AuthScreen({
  legacyRoomCount = 0,
  onAuthenticated,
  connectionError,
  onRetry,
}) {
  const [mode, setMode] = useState("login");
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [claimLegacy, setClaimLegacy] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const registering = mode === "register";
  const invited = new URLSearchParams(location.hash.slice(1)).has("invite");
  async function submit(event) {
    event.preventDefault();
    if (registering && password !== confirm) {
      setError("两次输入的密码不一致。");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api(`/api/auth/${mode}`, {
        method: "POST",
        body: { username, name, password, claimLegacy },
      });
      setPassword("");
      setConfirm("");
      announceAccountChange();
      await onAuthenticated(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="home auth-page">
      <header className="home-nav">
        <a className="brand" href="/">
          <span className="brand-mark" />
          <span>轻单</span>
          <small>想法与行动，都有归处</small>
        </a>
      </header>
      <main className="auth-main">
        <section className="auth-intro">
          <div className="eyebrow">属于你的轻单空间</div>
          <h1>
            留住灵感，
            <br />
            一起把事情完成<span className="heading-dot">.</span>
          </h1>
          <p>
            在画布里自由整理，在排列里专注行动。
            <br />
            登录自己的账号，随时接着上次的想法。
          </p>
          <ul className="auth-benefits">
            <li>
              <LayoutDashboard size={19} />
              <span>画布与灵感板，保存在你的账号下</span>
            </li>
            <li>
              <LockKeyhole size={19} />
              <span>个人内容，仅自己和受邀同伴可见</span>
            </li>
            <li>
              <Users size={19} />
              <span>分享邀请链接，实时一起编辑</span>
            </li>
          </ul>
        </section>
        <section
          className="dialog auth-card"
          aria-label={mode === "forgot" ? "找回密码" : "账号登录注册"}
        >
          {mode === "forgot" ? (
            <ForgotPassword
              initialUsername={username}
              connectionError={connectionError}
              onRetry={onRetry}
              onBack={(value) => {
                setUsername(value);
                setMode("login");
              }}
              onSuccess={(value) => {
                setUsername(value);
                setMode("login");
                setPassword("");
                setConfirm("");
                setNotice(
                  "密码已重置，请使用新密码登录。其他设备需要重新登录。",
                );
              }}
            />
          ) : (
            <>
              <div className="auth-tabs" role="group" aria-label="登录或注册">
                <button
                  type="button"
                  aria-pressed={registering}
                  disabled={busy}
                  onClick={() => {
                    setMode("register");
                    setError("");
                    setNotice("");
                    setPassword("");
                    setConfirm("");
                  }}
                >
                  注册账号
                </button>
                <button
                  type="button"
                  aria-pressed={!registering}
                  disabled={busy}
                  onClick={() => {
                    setMode("login");
                    setError("");
                    setNotice("");
                    setPassword("");
                    setConfirm("");
                  }}
                >
                  登录
                </button>
              </div>
              <h2>{registering ? "创建你的轻单账号" : "欢迎回来"}</h2>
              <p>
                {invited
                  ? "你收到了一份画布邀请，登录后将继续加入。"
                  : registering
                    ? "从一个账号开始，保存你的每个想法。"
                    : "登录后，继续你的画布和清单。"}
              </p>
              {notice && (
                <p className="account-notice" role="status">
                  {notice}
                </p>
              )}
              <form onSubmit={submit}>
                <fieldset disabled={busy || !!connectionError}>
                  <label>
                    用户名
                    <input
                      autoFocus
                      autoComplete="username"
                      autoCapitalize="none"
                      spellCheck={false}
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      minLength={3}
                      maxLength={32}
                      pattern="[a-zA-Z0-9_\-]{3,32}"
                      required
                      placeholder="例如 moon_notes"
                    />
                    <small>3–32 位英文字母、数字、下划线或短横线</small>
                  </label>
                  {registering && (
                    <label>
                      昵称
                      <input
                        autoComplete="nickname"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        maxLength={32}
                        placeholder="同伴怎么称呼你（选填）"
                      />
                    </label>
                  )}
                  <label>
                    密码
                    <input
                      type="password"
                      autoComplete={
                        registering ? "new-password" : "current-password"
                      }
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      minLength={9}
                      maxLength={128}
                      required
                      placeholder="9–128 个字符"
                    />
                  </label>
                  {registering && (
                    <label>
                      确认密码
                      <input
                        type="password"
                        autoComplete="new-password"
                        value={confirm}
                        onChange={(e) => setConfirm(e.target.value)}
                        minLength={9}
                        maxLength={128}
                        required
                        placeholder="再次输入密码"
                      />
                    </label>
                  )}
                  {legacyRoomCount > 0 && (
                    <label className="auth-claim">
                      <input
                        type="checkbox"
                        checked={claimLegacy}
                        onChange={(e) => setClaimLegacy(e.target.checked)}
                        required
                      />
                      <span>
                        将本浏览器原有的 {legacyRoomCount} 张画布归入此账号
                        <small>包含已同步的灵感板、清单和图片。</small>
                      </span>
                    </label>
                  )}
                  <button
                    className="primary wide"
                    disabled={busy || !!connectionError}
                  >
                    {busy ? "请稍候…" : registering ? "注册并进入" : "登录"}
                    <ArrowRight size={16} />
                  </button>
                </fieldset>
                {(error || connectionError) && (
                  <p className="form-error" role="alert">
                    {error || connectionError}
                    {connectionError && (
                      <button
                        type="button"
                        className="text-button"
                        onClick={onRetry}
                      >
                        重新连接
                      </button>
                    )}
                  </p>
                )}
              </form>
              {!registering && (
                <button
                  type="button"
                  className="text-button auth-forgot"
                  disabled={busy}
                  onClick={() => {
                    setMode("forgot");
                    setError("");
                    setNotice("");
                    setPassword("");
                    setConfirm("");
                  }}
                >
                  忘记密码？
                </button>
              )}
              <small className="auth-footnote">
                建议登录后在账号设置中绑定邮箱，以便忘记密码时验证找回。
              </small>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
