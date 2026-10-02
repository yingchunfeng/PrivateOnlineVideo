import { useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../auth";
import { mockEnabled } from "../api";
import { ErrorNotice, Loading } from "../ui";

export function LoginPage() {
  const auth = useAuth(); const location = useLocation();
  const [password, setPassword] = useState(""); const [totp, setTotp] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>();
  const [recovery, setRecovery] = useState(false);
  const from = (location.state as { from?: unknown } | null)?.from;
  const destination = typeof from === "string" && /^\/(?!\/)/.test(from) && !from.startsWith("/login") && !from.includes("\\") ? from : "/";
  if (auth.loading) return <Loading />;
  if (auth.session) return <Navigate to={destination} replace />;
  return <section className="narrow"><div className="eyebrow">ONLY FOR YOU</div><h1>留住你的片刻</h1><p className="muted">登录，回到只属于你的私人视频库。</p><div className="panel stack"><h2>安全登录</h2>{auth.expired && <div className="notice warning" role="status">会话未登录、已过期或被撤销，请重新验证。</div>}{auth.error !== undefined && <ErrorNotice error={auth.error} retry={auth.refresh} />}<form className="stack" onSubmit={async event => {
    event.preventDefault(); if (busy) return; setBusy(true); setError(undefined);
    try { await auth.login({ password, totp }); }
    catch (err) { setError(err); }
    finally { setPassword(""); setTotp(""); setBusy(false); }
  }}><label>密码<input autoComplete="current-password" type="password" value={password} onChange={e => setPassword(e.target.value)} required maxLength={512} disabled={busy} /></label><label>动态验证码<input autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={totp} onChange={e => setTotp(e.target.value.replace(/\D/g, ""))} required disabled={busy} /><small>输入验证器中的 6 位 TOTP 验证码。</small></label>{error !== undefined && <ErrorNotice error={error} />}<button type="submit" disabled={busy}>{busy ? "正在验证…" : "进入视频库"}</button></form><button className="secondary" aria-expanded={recovery} onClick={() => setRecovery(value => !value)}>无法使用动态验证码？</button>{recovery && <div className="notice"><strong>通过受保护的账户恢复流程恢复访问</strong><p>当前网站没有匿名重置入口。请使用账户初始化时保管的恢复资料，并由站点管理流程验证身份。</p><p className="muted">网页账户恢复功能尚未启用；恢复访问需要完成受保护的管理验证。恢复资料与长期密钥不要输入普通网页或分享给他人。</p></div>}{mockEnabled && <small>开发样例：密码 demo-password，验证码 123456。此处仅验证界面，不代表真实账户登录。</small>}</div></section>;
}
