import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import useResendCooldown from "./useResendCooldown.js";
import "./email-settings.css";

export default function EmailSettings({ user }) {
  // Remount all private state when the signed-in account changes.
  return <EmailSettingsPanel key={user.id} user={user} />;
}

function EmailSettingsPanel({ user }) {
  const [expanded, setExpanded] = useState(false);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState(false);
  const [email, setEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [challenge, setChallenge] = useState(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [retryIn, startCooldown] = useResendCooldown();
  const active = useRef(false);
  const pending = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (!expanded || profile) return;
    let current = true;
    setLoading(true);
    setError("");
    void (async () => {
      try {
        const result = await api("/api/profile/email", { accountId: user.id });
        if (current) setProfile(result);
      } catch (err) {
        if (current) setError(err.message);
      } finally {
        if (current) setLoading(false);
      }
    })();
    return () => {
      current = false;
    };
  }, [expanded, profile, reload, user.id]);

  async function sendCode(event) {
    event?.preventDefault();
    if (pending.current || retryIn || !profile?.available) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api("/api/profile/email/request", {
        method: "POST",
        accountId: user.id,
        body: { email: email.trim(), currentPassword },
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

  async function confirmEmail(event) {
    event.preventDefault();
    if (pending.current || !challenge) return;
    if (!/^\d{6}$/.test(code)) {
      setError("请输入六位数字验证码。");
      return;
    }
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api("/api/profile/email/confirm", {
        method: "POST",
        accountId: user.id,
        body: { email: email.trim(), code, challengeId: challenge.challengeId },
      });
      if (!active.current) return;
      setProfile((value) => ({ ...value, email: result.email }));
      setEditing(false);
      setEmail("");
      setCurrentPassword("");
      setChallenge(null);
      setCode("");
      setNotice("邮箱已绑定，可用于找回密码。");
    } catch (err) {
      if (active.current) setError(err.message);
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }

  return (
    <details
      className="email-settings"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>绑定邮箱与找回密码</summary>
      <div className="email-content">
        {loading && (
          <p className="account-hint" role="status">
            正在加载邮箱…
          </p>
        )}
        {profile && (
          <>
            {profile.email ? (
              <p className="email-identity" aria-label="已绑定邮箱">
                已绑定邮箱：<strong>{profile.email}</strong>
              </p>
            ) : (
              <p className="account-hint">
                尚未绑定邮箱。验证后可通过邮件验证码找回密码。
              </p>
            )}
            {!profile.available ? (
              <p className="account-notice">
                邮件验证服务尚未启用，请联系管理员。
              </p>
            ) : profile.email && !editing ? (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => {
                  setEditing(true);
                  setError("");
                  setNotice("");
                }}
              >
                更换邮箱
              </button>
            ) : (
              <form
                onSubmit={challenge ? confirmEmail : sendCode}
                aria-busy={busy}
              >
                <fieldset disabled={busy}>
                  {!challenge ? (
                    <>
                      {profile.email && (
                        <small className="account-hint">
                          新邮箱验证成功前，原绑定邮箱继续有效。
                        </small>
                      )}
                      <label>
                        邮箱
                        <input
                          type="email"
                          autoComplete="email"
                          autoCapitalize="none"
                          spellCheck={false}
                          value={email}
                          onChange={(event) => setEmail(event.target.value)}
                          maxLength={254}
                          required
                          placeholder="用于找回密码的邮箱"
                        />
                      </label>
                      <label>
                        当前密码
                        <input
                          type="password"
                          autoComplete="current-password"
                          value={currentPassword}
                          onChange={(event) =>
                            setCurrentPassword(event.target.value)
                          }
                          maxLength={128}
                          required
                          placeholder="验证这是你的账号"
                        />
                      </label>
                      <button
                        className="primary wide"
                        disabled={busy || retryIn > 0}
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
                      <p className="account-hint">
                        验证码已发送至 <strong>{email}</strong>
                        ，请检查收件箱和垃圾邮件。
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
                            setCode(
                              event.target.value.replace(/\D/g, "").slice(0, 6),
                            )
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
                      <button className="primary wide" disabled={busy}>
                        {busy ? "正在验证…" : "验证并绑定邮箱"}
                      </button>
                      <div className="account-actions">
                        <button
                          type="button"
                          className="text-button"
                          disabled={busy || retryIn > 0}
                          onClick={sendCode}
                        >
                          {retryIn > 0
                            ? `${retryIn} 秒后可重新发送`
                            : "重新发送验证码"}
                        </button>
                        <button
                          type="button"
                          className="text-button"
                          disabled={busy}
                          onClick={() => {
                            setChallenge(null);
                            setCode("");
                            setCurrentPassword("");
                            setError("");
                          }}
                        >
                          修改邮箱
                        </button>
                      </div>
                    </>
                  )}
                  {profile.email && (
                    <button
                      type="button"
                      className="secondary wide recovery-back"
                      disabled={busy}
                      onClick={() => {
                        setEditing(false);
                        setChallenge(null);
                        setCode("");
                        setEmail("");
                        setCurrentPassword("");
                        setError("");
                      }}
                    >
                      取消更换
                    </button>
                  )}
                </fieldset>
              </form>
            )}
          </>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
            {!profile && !loading && (
              <button
                type="button"
                className="text-button"
                onClick={() => setReload((value) => value + 1)}
              >
                重新加载
              </button>
            )}
          </p>
        )}
        {notice && (
          <p className="account-notice" role="status">
            {notice}
          </p>
        )}
      </div>
    </details>
  );
}
