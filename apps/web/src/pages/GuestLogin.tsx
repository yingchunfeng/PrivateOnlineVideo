import { useRef, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { useAuth } from "../auth";
import { landingPage } from "../authz";
import { ErrorNotice, Loading } from "../ui";
import "./account-security.css";
import "./guest-management.css";

export function GuestLoginPage() {
  const auth = useAuth(); const [password, setPassword] = useState(""); const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false); const submitting = useRef(false);
  if (auth.loading) return <Loading />;
  if (auth.session) return <Navigate to={landingPage(auth.session)} replace />;
  return <section className="narrow account-form guest-login"><div className="eyebrow">INVITED ACCESS</div><h1>访客登录</h1><p className="muted">使用管理员提供的临时密码，无需邮箱或动态验证码。</p><div className="panel stack">
    {auth.expired && <div className="notice warning" role="status">访客会话已过期、被提前失效或已撤销。请向管理员获取新的临时密码。</div>}
    {auth.error !== undefined && <ErrorNotice error={auth.error} retry={auth.refresh} />}
    <form className="stack" aria-label="访客登录" onSubmit={async event => { event.preventDefault(); if (submitting.current) return; submitting.current = true; setBusy(true); setError(undefined); try { await auth.loginGuest(password); setPassword(""); } catch (failure) { setError(failure); } finally { submitting.current = false; setBusy(false); } }}>
      <label>临时密码<input type="password" autoComplete="current-password" value={password} maxLength={512} required disabled={busy} onChange={event => { setPassword(event.target.value); setError(undefined); }} /></label>
      {error !== undefined && <ErrorNotice error={error} />}<button type="submit" disabled={busy || !password}>{busy ? "正在验证…" : "访客登录"}</button>
    </form><div className="notice">登录后仅能访问获授权的页面和操作。到期或管理员提前失效后，所有相关会话失效；此入口不能登录管理员身份。</div><Link className="text-link" to="/login">返回管理员登录</Link>
  </div></section>;
}
