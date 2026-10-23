import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import useResendCooldown from "./useResendCooldown.js";
import "./email-settings.css";

export default function ForgotPassword({
  initialUsername = "",
  onBack,
  onSuccess,
  connectionError,
  onRetry,
}) {
  const [username, setUsername] = useState(initialUsername);
  const [email, setEmail] = useState("");
  const [challenge, setChallenge] = useState(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retryIn, startCooldown] = useResendCooldown();
  const active = useRef(false);
  const pending = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  async function requestCode(event) {
    event?.preventDefault();
    if (pending.current || retryIn || connectionError) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await api("/api/auth/password-reset/request", {
        method: "POST",
        accountId: null,
        body: { username: username.trim(), email: email.trim() },
      });
      if (!active.current) return;
      setChallenge(result);
      setCode("");
      startCooldown(result.retryAfter);
    } catch (err) {
      if (active.current) setError(err.message);
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }

  async function resetPassword(event) {
    event.preventDefault();
    if (pending.current || connectionError || !challenge) return;
    if (password !== confirm) {
      setError("两次输入的新密码不一致。");
      return;
    }
    if (!/^\d{6}$/.test(code)) {
      setError("请输入六位数字验证码。");
      return;
    }
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/password-reset/confirm", {
        method: "POST",
        accountId: null,
        body: {
          username: username.trim(),
          email: email.trim(),
          code,
          challengeId: challenge.challengeId,
          password,
        },
      });
      if (active.current) onSuccess(username.trim());
    } catch (err) {
      if (active.current) setError(err.message);
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }

  return (
    <div className="account-flow">
      <h2>找回密码</h2>
      <p>使用用户名和已绑定的邮箱验证身份，设置新密码。</p>
      <form onSubmit={challenge ? resetPassword : requestCode} aria-busy={busy}>
        <fieldset disabled={busy || !!connectionError}>
          {!challenge ? (
            <>
              <label>
                用户名
                <input
                  autoFocus
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  minLength={3}
                  maxLength={32}
                  pattern="[a-zA-Z0-9_\-]{3,32}"
                  required
                  placeholder="注册时使用的用户名"
                />
              </label>
              <label>
                绑定邮箱
                <input
                  type="email"
                  autoComplete="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  maxLength={254}
                  required
                  placeholder="已在账号设置中验证的邮箱"
                />
              </label>
              <button
                className="primary wide"
                disabled={busy || retryIn > 0 || !!connectionError}
              >
                {busy
                  ? "正在发送…"
                  : retryIn > 0
                    ? `${retryIn} 秒后可发送`
                    : "发送验证码"}
              </button>
            </>
          ) : (
            <>
              <p className="account-notice" role="status">
                {challenge.message ||
                  "如果用户名和绑定邮箱匹配，验证码将发送至该邮箱，请检查收件箱和垃圾邮件。"}
              </p>
              <p className="email-identity">
                {username} · {email}
              </p>
              <label>
                验证码
                <input
                  autoFocus
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  value={code}
                  onChange={(event) =>
                    setCode(event.target.value.replace(/\D/g, "").slice(0, 6))
                  }
                  minLength={6}
                  maxLength={6}
                  required
                  placeholder="6 位数字"
                />
              </label>
              <small className="account-hint">
                验证码 10 分钟内有效，最多尝试 5
                次。重新发送后请使用最新验证码。
              </small>
              <label>
                新密码
                <input
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  minLength={9}
                  maxLength={128}
                  required
                  placeholder="9–128 个字符"
                />
              </label>
              <label>
                确认新密码
                <input
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  minLength={9}
                  maxLength={128}
                  required
                  placeholder="再次输入新密码"
                />
              </label>
              <button
                className="primary wide"
                disabled={busy || !!connectionError}
              >
                {busy ? "正在重置…" : "重置密码"}
              </button>
              <div className="account-actions">
                <button
                  type="button"
                  className="text-button"
                  disabled={busy || retryIn > 0 || !!connectionError}
                  onClick={requestCode}
                >
                  {retryIn > 0 ? `${retryIn} 秒后可重新发送` : "重新发送验证码"}
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => {
                    setChallenge(null);
                    setCode("");
                    setPassword("");
                    setConfirm("");
                    setError("");
                  }}
                >
                  修改用户名或邮箱
                </button>
              </div>
            </>
          )}
        </fieldset>
        {(error || connectionError) && (
          <p className="form-error" role="alert">
            {error || connectionError}
            {connectionError && (
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={onRetry}
              >
                重新连接
              </button>
            )}
          </p>
        )}
      </form>
      <button
        type="button"
        className="secondary wide recovery-back"
        disabled={busy}
        onClick={() => onBack(username.trim())}
      >
        返回登录
      </button>
      <small className="auth-footnote">
        尚未绑定邮箱的账号，需要先登录后在账号设置中完成绑定。
      </small>
    </div>
  );
}
