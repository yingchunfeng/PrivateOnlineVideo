import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { SetupStatus } from "@online-video/shared";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { api } from "./api";
import { installationApi } from "./api/installation";
import { ApiError } from "./api/client";
import { ErrorNotice, Loading } from "./ui";
import { InstallationSettings } from "./pages/InstallationSettings";
import "./pages/installation.css";

const setupApi = installationApi(api);
export function SetupGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SetupStatus>();
  const [error, setError] = useState<unknown>();
  const [revision, setRevision] = useState(0);
  const location = useLocation();
  const navigate = useNavigate();
  const accept = (value: SetupStatus) => {
    if (value.authenticated && value.csrfToken && value.stage !== "ready") api.setSession(value.csrfToken);
    else api.clearSession();
    setStatus(value); setError(undefined);
  };
  useEffect(() => {
    const controller = new AbortController();
    setError(undefined); setStatus(undefined);
    void setupApi.status(controller.signal).then(value => { if (!controller.signal.aborted) accept(value); }).catch(failure => { if (!controller.signal.aborted) setError(failure); });
    return () => controller.abort();
  }, [revision]);
  const refresh = () => setRevision(value => value + 1);
  if (error !== undefined) return <main id="main" className="installation-shell"><h1>检查安装状态</h1><ErrorNotice error={error} retry={refresh} /></main>;
  if (!status) return <main id="main" className="installation-shell"><Loading /></main>;
  if (status.stage === "ready") return location.pathname === "/setup" ? <Navigate to="/login" replace /> : children;
  if (location.pathname !== "/setup") return <Navigate to="/setup" replace />;
  return <main id="main" className="installation-shell"><div className="eyebrow">FIRST RUN</div><h1>云影匣 · 首次设置</h1><p className="muted">设置完成前，高光时刻和上传功能保持关闭。你填写的密钥仅发送给本站服务端。</p><ol className="installation-steps" aria-label="初始化步骤"><li aria-current={status.stage === "password" ? "step" : undefined}>验证安装码并修改密码</li><li aria-current={status.stage === "configuration" ? "step" : undefined}>配置 OSS 与邮件</li><li>完成后用新密码登录</li></ol>{!status.authenticated ? <SetupLogin status={status} accept={accept} /> : status.stage === "password" ? <SetupPassword accept={accept} refresh={refresh} /> : <InstallationSettings setup onExpired={refresh} onComplete={async () => {
    const result = await setupApi.complete();
    if (result.stage !== "ready") throw new ApiError("INVALID_RESPONSE", "服务端尚未确认初始化完成");
    accept(result);
    navigate("/login", { replace: true, state: { notice: "初始化完成，请使用你设置的新密码登录。邮箱验证默认关闭，可在系统设置中启用。" } });
  }} />}</main>;
}

function SetupLogin({ status, accept }: { status: SetupStatus; accept: (value: SetupStatus) => void }) {
  const [password, setPassword] = useState("");
  const [installationCode, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const initial = status.stage === "password";
  return <section className="panel stack installation-narrow"><h2>{initial ? "验证首次安装身份" : "继续未完成的设置"}</h2><p className="muted">{initial ? "首次密码为 adminadmin。还需要部署时生成、仅保存在服务器受保护文件中的一次性安装码。" : "初始密码和安装码已经失效，请使用刚刚设置的新密码继续。"}</p><form className="stack" aria-label="首次安装登录" onSubmit={async event => {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError(undefined);
    try { const result = await setupApi.login({ password, ...(initial ? { installationCode } : {}) }); setPassword(""); setCode(""); accept(result); }
    catch (failure) { setError(failure); setCode(""); }
    finally { setBusy(false); }
  }}><label>{initial ? "初始密码" : "已设置的新密码"}<input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required maxLength={512} disabled={busy} /></label>{initial && <label>一次性安装码<input type="password" autoComplete="off" value={installationCode} onChange={event => setCode(event.target.value)} required maxLength={512} disabled={busy} /><small>不要把安装码放进网址、截图或公开日志。</small></label>}{error !== undefined && <ErrorNotice error={error} />}<button disabled={busy || !password || initial && !installationCode}>{busy ? "正在验证…" : "继续设置"}</button></form></section>;
}

function SetupPassword({ accept, refresh }: { accept: (value: SetupStatus) => void; refresh: () => void }) {
  const [newPassword, setPassword] = useState(""); const [confirmPassword, setConfirm] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>();
  return <section className="panel stack installation-narrow"><h2>必须修改初始密码</h2><p className="muted">新密码为 12～128 个字符，不能继续使用 adminadmin。修改成功后旧安装会话失效。</p><form className="stack" aria-label="首次修改密码" onSubmit={async event => {
    event.preventDefault(); if (busy) return;
    if (newPassword !== confirmPassword || newPassword === "adminadmin") { setError(new ApiError("PASSWORD_POLICY_FAILED", "两次密码须一致，且不能使用初始密码")); return; }
    setBusy(true); setError(undefined);
    try { const result = await setupApi.password({ newPassword, confirmPassword }); setPassword(""); setConfirm(""); accept(result); }
    catch (failure) { if (failure instanceof ApiError && failure.status === 401) refresh(); else setError(failure); }
    finally { setBusy(false); }
  }}><label>新密码<input type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={newPassword} onChange={event => setPassword(event.target.value)} disabled={busy} /></label><label>确认新密码<input type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={confirmPassword} onChange={event => setConfirm(event.target.value)} disabled={busy} /></label>{error !== undefined && <ErrorNotice error={error} />}<button disabled={busy || !newPassword || !confirmPassword}>{busy ? "正在保存…" : "保存新密码并继续"}</button></form></section>;
}
