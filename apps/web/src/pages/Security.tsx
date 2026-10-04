import { useEffect, useRef, useState } from "react";
import type { ApplicationUsage, LoginSession } from "@online-video/shared";
import { api } from "../api";
import { useAuth } from "../auth";
import { presentUsage } from "../usage";
import { date, Empty, ErrorNotice, Loading, useLoad } from "../ui";
import { UsageDetails } from "../usage-panel";
import { authApi } from "../api/auth";
import { useFeedback } from "../feedback";
import { AccountSecurity } from "./account-security";

export function SecurityPage() {
  const auth = useAuth();
  const { toast, toastError, confirm: requestConfirmation } = useFeedback();
  const legacyUsageEnabled = false;
  const usage = useLoad(async () => { if (!legacyUsageEnabled) return undefined; const value = await api.request<ApplicationUsage>("/api/settings/usage"); return { value, display: presentUsage(value) }; });
  const sessions = useLoad(() => authApi(api).sessions());
  const [busy, setBusy] = useState(false);
  const logout = async () => {
    if (busy) return;
    setBusy(true);
    try { await auth.logout(); toast("已退出登录，请重新登录"); }
    catch (error) { toastError(error); } finally { setBusy(false); }
  };
  const revoke = async (session: LoginSession) => {
    if (busy || !await requestConfirmation({ title: session.isCurrent ? "撤销当前会话后需要重新登录" : "撤销这个登录会话？", message: `会话 ${session.id} 将无法继续管理视频和上传。公共视频地址仍可访问，视频和上传分片保持不变。`, confirmLabel: "确认撤销", danger: true })) return;
    setBusy(true);
    try { await authApi(api).revoke(session.id); toast("会话已撤销"); if (session.isCurrent) auth.revoked(); else sessions.reload(); }
    catch (error) { toastError(error); } finally { setBusy(false); }
  };
  return <><div className="eyebrow">PRIVATE, BY DESIGN</div><h1>账户安全</h1><p className="muted">查看和管理登录会话，保护视频上传与信息管理。</p><button className="secondary" onClick={() => void logout()} disabled={busy}>{busy ? "正在处理…" : "退出登录"}</button><AccountSecurity />{legacyUsageEnabled && <section className="panel"><div className="page-head"><div><h2>{usage.data?.value.source === "oss_direct" ? "OSS 直连用量" : "应用代理流量"}</h2><small>{usage.data?.value.source === "oss_direct" ? "直连实际字节未知" : "代理实际字节统计"}</small></div><button className="secondary" onClick={usage.reload}>刷新用量</button></div>{usage.busy ? <Loading /> : usage.error ? <ErrorNotice error={usage.error} retry={usage.reload} /> : usage.data && <UsageDetails value={usage.data.value} />}</section>}<section className="panel section-space stack"><div className="page-head"><div><h2>登录会话</h2><small>撤销后需重新登录才能上传或管理视频。公共视频地址仍可直接访问。</small></div><button className="secondary" onClick={sessions.reload}>刷新会话</button></div>{sessions.busy ? <Loading /> : sessions.error ? <ErrorNotice error={sessions.error} retry={sessions.reload} /> : sessions.data?.length === 0 ? <Empty title="当前没有可读取的会话" /> : <div className="session-list">{sessions.data?.map(session => <article className="session-item" key={session.id}><div><h3>{session.isCurrent ? "当前会话" : "其他登录会话"}</h3><small>会话编号：{session.id}</small><small>创建：{date(session.createdAt)}</small><small>最近活动：{date(session.lastSeenAt)}</small><small>过期：{date(session.expiresAt)}</small></div><button className="secondary" onClick={() => void revoke(session)} disabled={busy}>{session.isCurrent ? "撤销当前会话" : "撤销此会话"}</button></article>)}</div>}</section><section className="panel"><h2>账户保护</h2><p>{auth.session?.user.authMethod === "email" ? "邮箱验证码登录已启用；保留的 TOTP 配置仅供受保护恢复使用。" : "当前使用密码与 TOTP 登录，完成邮箱验证后可切换登录方式。"}</p><p className="muted">账户不开放公众注册。公共视频地址可直接访问，账户恢复按受保护流程操作。</p></section></>;
}
