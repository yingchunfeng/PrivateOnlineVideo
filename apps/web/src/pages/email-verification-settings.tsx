import { useState } from "react";
import type { EmailChallenge, SmtpSettingsSummary } from "@online-video/shared";
import { findEmailProvider } from "@online-video/shared";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { authApi } from "../api/auth";
import { useAuth } from "../auth";
import { EmailCodeField, EmailProviderHint, useVerificationClock } from "../account-verification";
import { ErrorNotice, Loading, useLoad } from "../ui";

export function EmailVerificationSettings({ mail }: { mail: SmtpSettingsSummary[] }) {
  const client = authApi(api); const auth = useAuth(); const navigate = useNavigate();
  const summary = useLoad(() => client.security());
  const [currentPassword, setPassword] = useState(""); const [email, setEmail] = useState("");
  const [challenge, setChallenge] = useState<EmailChallenge>(); const [code, setCode] = useState("");
  const [error, setError] = useState<unknown>(); const [busy, setBusy] = useState(false);
  const clock = useVerificationClock(challenge);
  if (summary.busy) return <Loading />;
  if (summary.error || !summary.data) return <ErrorNotice error={summary.error} retry={summary.reload} />;
  if (summary.data.authMethod === "totp") return <section className="panel"><h2>登录邮箱验证</h2><p>当前账号使用 TOTP。保留原验证方式；如需切换邮箱登录，请在账户安全中完成原有绑定验证流程。</p></section>;
  const enabled = summary.data.authMethod === "email";
  const targetEmail = enabled ? summary.data.email ?? "" : email.trim();
  const provider = findEmailProvider(targetEmail, summary.data.emailProviders);
  const configured = !!provider && mail.some(item => item.providerCode === provider.code && item.passwordConfigured && !!item.testedAt);
  const invalidate = () => { setChallenge(undefined); setCode(""); setError(undefined); };
  const send = async () => {
    if (busy || !currentPassword || clock.cooldown || !configured) return;
    setBusy(true); setError(undefined);
    try { setChallenge(await client.emailVerificationCode({ currentPassword, enabled: !enabled, ...(!enabled ? { email: targetEmail } : {}) })); setCode(""); }
    catch (failure) { setError(failure); }
    finally { setBusy(false); }
  };
  return <section className="panel stack" aria-label="登录邮箱验证"><h2>登录邮箱验证：{enabled ? "已开启" : "未开启"}</h2><p className="muted">{enabled ? "关闭时需要当前密码和已绑定邮箱的验证码，避免仅凭现有会话关闭验证。" : "默认使用密码登录。开启前需保存并测试对应邮箱服务，然后输入收件邮箱的验证码确认归属。"} 修改成功后所有会话失效，需重新登录。</p><EmailProviderHint providers={summary.data.emailProviders} /><form className="stack" onSubmit={async event => {
    event.preventDefault(); if (busy || !challenge || clock.expired) return;
    setBusy(true); setError(undefined);
    try {
      await client.emailVerificationConfirm({ currentPassword, enabled: !enabled, ...(!enabled ? { email: targetEmail } : {}), challengeId: challenge.challengeId, code });
      setPassword(""); setEmail(""); setCode(""); setChallenge(undefined); auth.revoked();
      navigate("/login", { replace: true, state: { notice: enabled ? "邮箱验证已关闭，请使用密码重新登录。" : "邮箱验证已开启，请使用密码和邮箱验证码重新登录。" } });
    } catch (failure) { setError(failure); }
    finally { setBusy(false); }
  }}><label>当前密码<input type="password" autoComplete="current-password" value={currentPassword} onChange={event => { setPassword(event.target.value); invalidate(); }} required maxLength={512} disabled={busy} /></label>{enabled ? <p>已绑定邮箱：{summary.data.email}</p> : <label>接收登录验证码的邮箱<input type="email" autoComplete="email" value={email} onChange={event => { setEmail(event.target.value); invalidate(); }} required maxLength={254} disabled={busy} /></label>}{!configured && <div className="notice">请先保存并测试此收件邮箱类型的 SMTP 配置。</div>}<button type="button" className="secondary" disabled={busy || !currentPassword || !configured || clock.cooldown > 0} onClick={() => void send()}>{clock.cooldown ? `${clock.cooldown} 秒后可重发` : enabled ? "发送关闭验证的验证码" : "发送开启验证的验证码"}</button>{challenge && <EmailCodeField challenge={challenge} code={code} onChange={setCode} disabled={busy} label="设置确认验证码" />}{error !== undefined && <ErrorNotice error={error} />}<button disabled={busy || !challenge || clock.expired || code.length !== 6 || !configured}>{enabled ? "确认关闭邮箱验证" : "确认开启邮箱验证"}</button></form></section>;
}
