import { useState } from "react";
import { findEmailProvider } from "@online-video/shared";
import type { AccountMutationResult, AccountSecuritySummary, EmailChallenge, EmailChangeAuthorization, EmailProviderType } from "@online-video/shared";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { authApi } from "../api/auth";
import { ApiError } from "../api/client";
import { useAuth } from "../auth";
import { useFeedback } from "../feedback";
import { EmailCodeField, EmailProviderHint, useVerificationClock } from "../account-verification";
import { date, ErrorNotice, Loading, useLoad } from "../ui";
import "./account-security.css";

const accountApi = authApi(api);
const validEmail = (email: string, providers: readonly EmailProviderType[]) => !!findEmailProvider(email, providers);
type CompleteChange = (result: AccountMutationResult, message: string) => void;

function useAccountTask() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(undefined);
    try { await action(); } catch (failure) { setError(failure); } finally { setBusy(false); }
  };
  return { busy, error, run };
}

export function AccountSecurity() {
  const auth = useAuth(); const navigate = useNavigate(); const { toast } = useFeedback();
  const summary = useLoad(() => accountApi.security());
  const complete: CompleteChange = (result, message) => {
    const notification = result.notificationStatus === "failed" ? "安全通知未能发送，账号修改已完成。" : result.notificationStatus === "pending" ? "安全通知等待发送，账号修改已完成。" : "";
    const notice = `${message} 全部登录会话已撤销，请重新登录。${notification ? ` ${notification}` : ""}`;
    toast(notice);
    auth.revoked();
    navigate("/login", { replace: true, state: { notice } });
  };
  return <div className="account-security stack section-space">{summary.busy ? <Loading /> : summary.error ? <ErrorNotice error={summary.error} retry={summary.reload} /> : summary.data && <><section className="panel stack" aria-label="账号安全摘要"><div className="page-head"><h2>账号安全摘要</h2><button className="secondary" onClick={summary.reload}>刷新安全信息</button></div><dl className="metadata"><div><dt>当前登录方式</dt><dd>{summary.data.authMethod === "email" ? "密码 + 邮箱验证码" : summary.data.authMethod === "password" ? "密码登录" : "密码 + TOTP"}</dd></div><div><dt>绑定邮箱</dt><dd>{summary.data.email ?? "尚未绑定"}<small>{summary.data.emailVerified ? `已验证${summary.data.emailVerifiedAt ? ` · ${date(summary.data.emailVerifiedAt)}` : ""}` : summary.data.email ? "待重新验证" : "绑定成功后切换为邮箱验证码登录"}</small></dd></div><div><dt>TOTP 配置</dt><dd>{summary.data.authMethod === "totp" && summary.data.totpAvailable ? "用于当前登录" : summary.data.totpAvailable ? "已保留，供受保护恢复使用" : "未配置"}</dd></div></dl></section>{summary.data.authMethod === "password" ? <><PasswordOnlyForm complete={complete} /><Link className="text-link" to="/settings">配置邮件和登录邮箱验证</Link></> : summary.data.authMethod === "totp" ? <BindEmailForm summary={summary.data} complete={complete} /> : <div className="account-form-grid"><PasswordForm complete={complete} /><ChangeEmailForm summary={summary.data} complete={complete} /></div>}</>}</div>;
}

function PasswordOnlyForm({ complete }: { complete: CompleteChange }) {
  const [currentPassword, setPassword] = useState(""); const [newPassword, setNew] = useState(""); const [confirmPassword, setConfirm] = useState("");
  const task = useAccountTask();
  return <section className="panel stack account-form" aria-label="修改密码"><h2>修改密码</h2><p className="muted">当前未开启邮箱验证。修改密码需验证当前密码，成功后撤销全部登录会话。</p><form className="stack" onSubmit={event => {
    event.preventDefault(); void task.run(async () => {
      if (newPassword !== confirmPassword) throw new ApiError("PASSWORD_POLICY_FAILED", "两次输入的新密码必须一致");
      const result = await accountApi.passwordDirect({ currentPassword, newPassword, confirmPassword });
      setPassword(""); setNew(""); setConfirm(""); complete(result, "密码修改成功。");
    });
  }}><label>当前密码<input type="password" autoComplete="current-password" required maxLength={512} value={currentPassword} onChange={event => setPassword(event.target.value)} disabled={task.busy} /></label><label>新密码<input type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={newPassword} onChange={event => setNew(event.target.value)} disabled={task.busy} /><small>12～128 个字符，不能与当前密码相同。</small></label><label>确认新密码<input type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={confirmPassword} onChange={event => setConfirm(event.target.value)} disabled={task.busy} /></label>{task.error !== undefined && <ErrorNotice error={task.error} />}<button disabled={task.busy || !currentPassword || !newPassword || !confirmPassword}>确认修改密码</button></form></section>;
}

function BindEmailForm({ summary, complete }: { summary: AccountSecuritySummary; complete: CompleteChange }) {
  const [currentPassword, setPassword] = useState(""); const [totp, setTotp] = useState("");
  const [email, setEmail] = useState(summary.email ?? ""); const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<EmailChallenge>();
  const task = useAccountTask(); const clock = useVerificationClock(challenge);
  const send = () => task.run(async () => {
    const next = await accountApi.bindCode({ currentPassword, totp, email: email.trim() });
    if (!next.operationId) throw new ApiError("INVALID_RESPONSE", "邮箱绑定操作编号缺失，请重新发送");
    setChallenge(next); setCode("");
  });
  const cancel = () => task.run(async () => {
    if (challenge?.operationId) await accountApi.cancelOperation({ operationId: challenge.operationId });
    setChallenge(undefined); setCode(""); setPassword(""); setTotp("");
  });
  return <section className="panel stack account-form" aria-label="绑定邮箱"><h2>{summary.email ? "重新验证邮箱" : "首次绑定邮箱"}</h2><p className="muted">验证当前密码与 TOTP，再验证目标邮箱。成功后切换为邮箱验证码登录，并撤销全部登录会话；验证成功前继续使用 TOTP。</p><EmailProviderHint providers={summary.emailProviders} /><form className="stack" onSubmit={event => {
    event.preventDefault(); if (!challenge?.operationId || clock.expired) return;
    void task.run(async () => {
      const result = await accountApi.bindConfirm({ currentPassword, totp, operationId: challenge.operationId!, challengeId: challenge.challengeId, code });
      setPassword(""); setTotp(""); setCode(""); setChallenge(undefined);
      complete(result, "邮箱验证成功，已切换为邮箱验证码登录。");
    });
  }}><label>当前密码<input autoComplete="current-password" type="password" required maxLength={512} value={currentPassword} onChange={event => setPassword(event.target.value)} disabled={task.busy} /></label><label>当前 TOTP 验证码<input autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required value={totp} onChange={event => setTotp(event.target.value.replace(/\D/g, ""))} disabled={task.busy} /><small>提交绑定时须输入当前有效的 TOTP。</small></label><label>绑定邮箱<input autoComplete="email" type="email" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} disabled={task.busy || !!challenge} /></label><div className="account-actions"><button type="button" className="secondary" disabled={task.busy || !currentPassword || totp.length !== 6 || !validEmail(email, summary.emailProviders) || clock.cooldown > 0} onClick={() => void send()}>{task.busy ? "正在处理…" : clock.cooldown ? `${clock.cooldown} 秒后可重发` : challenge ? "重新发送绑定验证码" : "发送绑定验证码"}</button>{challenge && <button type="button" className="secondary" disabled={task.busy} onClick={() => void cancel()}>取消绑定</button>}</div>{challenge && <EmailCodeField challenge={challenge} code={code} onChange={setCode} disabled={task.busy} label="绑定邮箱验证码" />}{task.error !== undefined && <ErrorNotice error={task.error} />}<button type="submit" disabled={task.busy || !challenge || clock.expired || !currentPassword || totp.length !== 6 || code.length !== 6}>验证并绑定邮箱</button></form><small>未绑定已验证邮箱的账号，请先完成此步骤，再使用修改密码和修改邮箱功能。</small></section>;
}

function PasswordForm({ complete }: { complete: CompleteChange }) {
  const [currentPassword, setPassword] = useState(""); const [newPassword, setNewPassword] = useState(""); const [confirmPassword, setConfirm] = useState("");
  const [code, setCode] = useState(""); const [challenge, setChallenge] = useState<EmailChallenge>();
  const task = useAccountTask(); const clock = useVerificationClock(challenge);
  const send = () => task.run(async () => {
    const next = await accountApi.passwordCode({ currentPassword });
    if (!next.operationId) throw new ApiError("INVALID_RESPONSE", "密码修改操作编号缺失，请重新发送");
    setChallenge(next); setCode("");
  });
  const cancel = () => task.run(async () => {
    if (challenge?.operationId) await accountApi.cancelOperation({ operationId: challenge.operationId });
    setChallenge(undefined); setCode(""); setPassword(""); setNewPassword(""); setConfirm("");
  });
  return <section className="panel stack account-form" aria-label="修改密码"><h2>修改密码</h2><p className="muted">验证当前密码及绑定邮箱。修改成功后，全部登录会话和未完成验证码操作失效。</p><form className="stack" onSubmit={event => {
    event.preventDefault(); if (!challenge?.operationId || clock.expired) return;
    void task.run(async () => {
      if (newPassword.length < 12 || newPassword.length > 128 || newPassword !== confirmPassword) throw new ApiError("PASSWORD_POLICY_FAILED", "新密码须为 12～128 个字符，且两次输入一致");
      if (newPassword === currentPassword) throw new ApiError("PASSWORD_UNCHANGED", "新密码不能与当前密码相同");
      const result = await accountApi.passwordConfirm({ currentPassword, newPassword, confirmPassword, operationId: challenge.operationId!, challengeId: challenge.challengeId, code });
      setPassword(""); setNewPassword(""); setConfirm(""); setCode(""); setChallenge(undefined);
      complete(result, "密码修改成功，请使用新密码登录。");
    });
  }}><label>当前密码<input type="password" autoComplete="current-password" required maxLength={512} value={currentPassword} onChange={event => setPassword(event.target.value)} disabled={task.busy} /></label><label>新密码<input type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={newPassword} onChange={event => setNewPassword(event.target.value)} disabled={task.busy} /><small>12～128 个字符，不能与当前密码相同。</small></label><label>确认新密码<input type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={confirmPassword} onChange={event => setConfirm(event.target.value)} disabled={task.busy} /></label><div className="account-actions"><button className="secondary" type="button" onClick={() => void send()} disabled={task.busy || !currentPassword || clock.cooldown > 0}>{task.busy ? "正在处理…" : clock.cooldown ? `${clock.cooldown} 秒后可重发` : challenge ? "重新发送密码验证码" : "发送密码验证码"}</button>{challenge && <button className="secondary" type="button" onClick={() => void cancel()} disabled={task.busy}>取消修改密码</button>}</div>{challenge && <EmailCodeField challenge={challenge} code={code} onChange={setCode} disabled={task.busy} label="绑定邮箱验证码" />}{task.error !== undefined && <ErrorNotice error={task.error} />}<button type="submit" disabled={task.busy || !challenge || clock.expired || !currentPassword || !newPassword || !confirmPassword || code.length !== 6}>确认修改密码</button></form></section>;
}

function ChangeEmailForm({ summary, complete }: { summary: AccountSecuritySummary; complete: CompleteChange }) {
  const [currentPassword, setPassword] = useState(""); const [newEmail, setEmail] = useState("");
  const [oldChallenge, setOldChallenge] = useState<EmailChallenge>(); const [newChallenge, setNewChallenge] = useState<EmailChallenge>();
  const [authorization, setAuthorization] = useState<EmailChangeAuthorization>(); const [oldCode, setOldCode] = useState(""); const [newCode, setNewCode] = useState("");
  const task = useAccountTask(); const oldClock = useVerificationClock(oldChallenge); const newClock = useVerificationClock(newChallenge); const authorizationClock = useVerificationClock(authorization);
  const sendOld = () => task.run(async () => {
    const next = await accountApi.emailOldCode({ currentPassword, newEmail: newEmail.trim() });
    if (!next.operationId) throw new ApiError("INVALID_RESPONSE", "邮箱修改操作编号缺失，请重新开始");
    setOldChallenge(next); setOldCode("");
  });
  const sendNew = () => task.run(async () => {
    if (!authorization || authorizationClock.expired) throw new ApiError("ACCOUNT_OPERATION_INVALID", "旧邮箱验证授权已过期，请取消后重新开始");
    const next = await accountApi.emailNewCode({ operationId: authorization.operationId });
    if (next.operationId !== authorization.operationId) throw new ApiError("INVALID_RESPONSE", "新邮箱验证码不属于当前操作，请重新开始");
    setNewChallenge(next); setNewCode("");
  });
  const cancel = () => task.run(async () => {
    const operationId = authorization?.operationId ?? oldChallenge?.operationId;
    if (operationId) await accountApi.cancelOperation({ operationId });
    setOldChallenge(undefined); setNewChallenge(undefined); setAuthorization(undefined); setOldCode(""); setNewCode(""); setPassword(""); setEmail("");
  });
  return <section className="panel stack account-form" aria-label="修改邮箱"><h2>修改邮箱</h2><p className="muted">依次验证旧邮箱与目标新邮箱。完成前，原绑定 {summary.email} 保持有效。</p><EmailProviderHint providers={summary.emailProviders} /><ol className="account-steps" aria-label="邮箱修改步骤"><li aria-current={!authorization ? "step" : undefined}>验证旧邮箱</li><li aria-current={authorization ? "step" : undefined}>验证新邮箱</li></ol><form className="stack" onSubmit={event => {
    event.preventDefault();
    void task.run(async () => {
      if (!authorization) {
        if (!oldChallenge?.operationId || oldClock.expired) return;
        const value = await accountApi.emailVerifyOld({ currentPassword, operationId: oldChallenge.operationId, challengeId: oldChallenge.challengeId, code: oldCode });
        if (!value || value.operationId !== oldChallenge.operationId || !value.targetEmailMasked || ![value.expiresAt, value.serverTime].every(time => Number.isFinite(Date.parse(time)))) throw new ApiError("INVALID_RESPONSE", "旧邮箱验证授权无效，请重新开始");
        setAuthorization(value); setOldCode("");
      } else {
        if (!newChallenge || newClock.expired || authorizationClock.expired) return;
        const result = await accountApi.emailConfirm({ currentPassword, operationId: authorization.operationId, challengeId: newChallenge.challengeId, code: newCode });
        setPassword(""); setEmail(""); setOldCode(""); setNewCode(""); setOldChallenge(undefined); setNewChallenge(undefined); setAuthorization(undefined);
        complete(result, "邮箱修改成功，请通过新邮箱接收登录验证码。");
      }
    });
  }}><label>当前密码<input type="password" autoComplete="current-password" required maxLength={512} value={currentPassword} onChange={event => setPassword(event.target.value)} disabled={task.busy} /></label><label>新邮箱<input type="email" autoComplete="email" required maxLength={254} value={newEmail} onChange={event => setEmail(event.target.value)} disabled={task.busy || !!oldChallenge || !!authorization} /><small>{oldChallenge ? "目标邮箱已锁定；更换目标需取消后重新验证旧邮箱。" : "填写目标新邮箱后开始验证，不能与当前邮箱相同。"}</small></label>{!authorization ? <><button className="secondary" type="button" disabled={task.busy || !currentPassword || !validEmail(newEmail, summary.emailProviders) || oldClock.cooldown > 0} onClick={() => void sendOld()}>{task.busy ? "正在处理…" : oldClock.cooldown ? `${oldClock.cooldown} 秒后可重发` : oldChallenge ? "重新发送旧邮箱验证码" : "发送旧邮箱验证码"}</button>{oldChallenge && <EmailCodeField challenge={oldChallenge} code={oldCode} onChange={setOldCode} disabled={task.busy} label="旧邮箱验证码" />}</> : <><div className={`notice ${authorizationClock.expired ? "warning" : ""}`} role="status"><strong>{authorizationClock.expired ? "旧邮箱授权已过期，请取消后重新开始" : "旧邮箱已验证"}</strong><small>本次目标：{authorization.targetEmailMasked}；授权还剩 {authorizationClock.remaining} 秒。</small></div><button className="secondary" type="button" disabled={task.busy || authorizationClock.expired || newClock.cooldown > 0} onClick={() => void sendNew()}>{task.busy ? "正在处理…" : newClock.cooldown ? `${newClock.cooldown} 秒后可重发` : newChallenge ? "重新发送新邮箱验证码" : "发送新邮箱验证码"}</button>{newChallenge && <EmailCodeField challenge={newChallenge} code={newCode} onChange={setNewCode} disabled={task.busy || authorizationClock.expired} label="新邮箱验证码" />}</>}{task.error !== undefined && <ErrorNotice error={task.error} />}<div className="account-actions"><button type="submit" disabled={task.busy || !currentPassword || (!authorization ? !oldChallenge || oldClock.expired || oldCode.length !== 6 : !newChallenge || newClock.expired || authorizationClock.expired || newCode.length !== 6)}>{authorization ? "确认修改邮箱" : "验证旧邮箱并继续"}</button>{(oldChallenge || authorization) && <button className="secondary" type="button" onClick={() => void cancel()} disabled={task.busy}>取消修改邮箱</button>}</div></form></section>;
}
