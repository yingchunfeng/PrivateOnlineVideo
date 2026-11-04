import { useState } from "react";
import type { EmailChallenge } from "@online-video/shared";
import { Link, Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../auth";
import { landingPage } from "../authz";
import { api, mockEnabled } from "../api";
import { authApi } from "../api/auth";
import { ApiError } from "../api/client";
import { ErrorNotice, Loading, useLoad } from "../ui";
import { useFeedback } from "../feedback";
import { EmailCodeField, EmailProviderHint, useVerificationClock } from "../account-verification";
import "./account-security.css";

export function LoginPage() {
  const auth = useAuth(); const location = useLocation();
  const [password, setPassword] = useState(""); const [totp, setTotp] = useState("");
  const [code, setCode] = useState(""); const [challenge, setChallenge] = useState<EmailChallenge>();
  const [error, setError] = useState<unknown>();
  const options = useLoad(() => authApi(api).options());
  const clock = useVerificationClock(challenge);
  const [busy, setBusy] = useState(false); const { toastError } = useFeedback();
  const [recovery, setRecovery] = useState(false);
  const loginState = location.state as { from?: unknown; notice?: unknown } | null;
  const from = loginState?.from;
  const destination = typeof from === "string" && /^\/(?!\/)/.test(from) && !from.startsWith("/login") && !from.includes("\\") ? from : "/";
  if (auth.loading) return <Loading />;
  if (auth.session) return <Navigate to={auth.session.guest ? landingPage(auth.session) : destination} replace />;
  const emailMode = options.data?.authMethod === "email";
  const passwordMode = options.data?.authMethod === "password";
  const report = (failure: unknown) => {
    setError(failure); toastError(failure);
    if (failure instanceof ApiError && ["AUTH_METHOD_MISMATCH", "ACCOUNT_VERSION_CONFLICT"].includes(failure.code)) { setChallenge(undefined); setCode(""); options.reload(); }
  };
  const sendCode = async () => {
    if (busy || !password || clock.cooldown) return;
    setBusy(true); setError(undefined);
    try { setChallenge(await authApi(api).loginCode({ password })); setCode(""); }
    catch (failure) { report(failure); }
    finally { setBusy(false); }
  };
  return <section className="narrow account-form"><h1>云影匣</h1><p className="muted">登录，个人拍摄的演唱会视频分享。</p><div className="panel stack"><h2>安全登录</h2><Link className="text-link" to="/guest/login">使用临时密码访客登录</Link>{typeof loginState?.notice === "string" && <div className="notice" role="status">{loginState.notice}</div>}{auth.expired && !loginState?.notice && <div className="notice warning" role="status">会话未登录、已过期或被撤销，请重新验证。</div>}{auth.error !== undefined && <ErrorNotice error={auth.error} retry={auth.refresh} />}{options.busy ? <Loading /> : options.error ? <ErrorNotice error={options.error} retry={options.reload} /> : <form className="stack" aria-label="安全登录" onSubmit={async event => {
    event.preventDefault(); if (busy || emailMode && (!challenge || clock.expired)) return; setBusy(true); setError(undefined);
    try {
      await auth.login(emailMode && challenge ? { authMethod: "email", password, challengeId: challenge.challengeId, code } : passwordMode ? { authMethod: "password", password } : { authMethod: "totp", password, totp });
      setPassword(""); setTotp(""); setCode(""); setChallenge(undefined);
    } catch (failure) { report(failure); setCode(""); setTotp(""); }
    finally { setBusy(false); }
  }}><EmailProviderHint providers={options.data?.emailProviders ?? []} /><p className="muted">{emailMode ? "验证密码后，向已验证的绑定邮箱发送登录验证码。" : passwordMode ? "使用你设置的管理员密码登录。可在系统设置中配置邮件，再开启邮箱验证。" : "使用当前密码和验证器中的 TOTP 登录；绑定邮箱前，此方式继续有效。"}</p><label>密码<input autoComplete="current-password" type="password" value={password} onChange={event => { setPassword(event.target.value); setError(undefined); }} required maxLength={512} disabled={busy} /></label>{emailMode ? <><button className="secondary" type="button" onClick={() => void sendCode()} disabled={busy || !password || clock.cooldown > 0}>{busy ? "正在处理…" : clock.cooldown ? `${clock.cooldown} 秒后可重发` : challenge ? "重新发送验证码" : "发送验证码"}</button>{challenge && <EmailCodeField challenge={challenge} code={code} onChange={setCode} disabled={busy} />}</> : !passwordMode && <label>动态验证码<input autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={totp} onChange={event => setTotp(event.target.value.replace(/\D/g, ""))} required disabled={busy} /><small>输入验证器中的 6 位 TOTP 验证码。</small></label>}{error !== undefined && <ErrorNotice error={error} />}<button type="submit" disabled={busy || !password || (emailMode ? !challenge || clock.expired || code.length !== 6 : !passwordMode && totp.length !== 6)}>{busy ? "正在验证…" : "进入高光时刻"}</button></form>}<button className="secondary" aria-expanded={recovery} onClick={() => setRecovery(value => !value)}>无法使用验证码？</button>{recovery && <div className="notice"><strong>通过受保护的账户恢复流程恢复访问</strong><p>请在本地受保护管理环境中，使用当前密码和未使用的恢复码生成新的 TOTP 与恢复资料。恢复后，使用当前密码与新 TOTP 登录，再验证邮箱。</p><p className="muted">当前网站没有匿名密码或邮箱重置入口。恢复码与长期密钥请只交给受保护的本地恢复流程。</p></div>}{mockEnabled && <small>开发样例：初始密码 demo-password，TOTP / 邮箱验证码 123456。此处仅验证界面，不代表真实账户或真实邮件。</small>}</div></section>;
}
