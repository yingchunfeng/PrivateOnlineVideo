import { useEffect, useState } from "react";
import type { InstallationSettingsSummary, OssSettingsSummary, SaveOssSettingsRequest, SaveSmtpSettingsRequest, SmtpSettingsSummary } from "@online-video/shared";
import { Link } from "react-router-dom";
import { api } from "../api";
import { ApiError } from "../api/client";
import { installationApi } from "../api/installation";
import { ErrorNotice, Loading, date } from "../ui";
import { EmailVerificationSettings } from "./email-verification-settings";
import "./installation.css";

const settingsApi = installationApi(api);
export function InstallationSettingsPage() {
  return <><div className="eyebrow">SYSTEM SETTINGS</div><h1>系统设置</h1><p className="muted">管理服务端 OSS 与邮件配置。已保存的密钥不回显，留空代表保持原值。</p><InstallationSettings /></>;
}

export function InstallationSettings({ setup = false, onComplete, onExpired }: { setup?: boolean; onComplete?: () => Promise<void>; onExpired?: () => void }) {
  const [summary, setSummary] = useState<InstallationSettingsSummary>();
  const [error, setError] = useState<unknown>(); const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(""); const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true; setLoading(true); setError(undefined);
    void settingsApi.settings().then(value => { if (active) setSummary(value); }).catch(failure => {
      if (!active) return;
      if (failure instanceof ApiError && failure.status === 401 && onExpired) onExpired(); else setError(failure);
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [revision]);
  const act = async (action: () => Promise<void>) => {
    if (busy) return false;
    setBusy(true); setError(undefined); setNotice("");
    try { await action(); return true; }
    catch (failure) { if (failure instanceof ApiError && failure.status === 401 && onExpired) onExpired(); else setError(failure); return false; }
    finally { setBusy(false); }
  };
  if (loading) return <Loading />;
  if (!summary) return <ErrorNotice error={error ?? new ApiError("INVALID_RESPONSE", "配置摘要尚未加载")} retry={() => setRevision(value => value + 1)} />;
  return <div className="stack section-space installation-form"><div className="page-head"><p className="muted">配置版本：{summary.version}</p><button className="secondary" disabled={busy} onClick={() => setRevision(value => value + 1)}>重新读取配置</button></div>{error !== undefined && <ErrorNotice error={error} />}{notice && <div className="notice" role="status">{notice}</div>}
    <OssForm key={`oss-${summary.version}`} value={summary.oss} version={summary.version} busy={busy} setup={setup} checkedAt={summary.ossTest?.checkedAt ?? null} save={body => act(async () => { setSummary(await settingsApi.saveOss(body)); setNotice("OSS 配置已保存。密钥已由服务端加密保管，请继续检查连通性。"); })} test={() => act(async () => { const result = await settingsApi.testOss(summary.version); setSummary(await settingsApi.settings()); setNotice(`OSS 前缀列表读取成功（${date(result.checkedAt)}）。此项未创建对象，不能证明上传权限或实际播放已通过。`); })} />
    <MailForms summary={summary} busy={busy} save={body => act(async () => { setSummary(await settingsApi.saveMail(body)); setNotice("邮件配置已保存。请主动发送测试邮件，并到收件箱确认。"); })} test={(providerCode, to) => act(async () => { const result = await settingsApi.testMail({ version: summary.version, providerCode, to }); setSummary(await settingsApi.settings()); setNotice(`SMTP 已接受发往 ${result.toMasked} 的测试邮件。请检查收件箱或垃圾邮件；服务器接受不等于收件箱已送达。`); })} />
    {setup ? <section className="panel stack"><h2>完成初始化</h2><p className="muted">OSS 为必填。邮件可以稍后配置；完成后默认使用密码登录，邮箱验证默认关闭。启用邮箱验证需要先配置并测试邮件，再验证收件邮箱。</p><button disabled={busy || !summary.oss?.secretConfigured || !summary.ossTest || !onComplete} onClick={() => void act(async () => { await onComplete?.(); })}>{busy ? "正在处理…" : "完成设置，前往登录"}</button>{!summary.ossTest && <small>请先保存 OSS 配置并完成只读连通检查。</small>}</section> : <><EmailVerificationSettings mail={summary.mail} /><Link className="text-link installation-settings-link" to="/security">前往账户安全修改密码和管理会话</Link></>}
  </div>;
}

function OssForm({ value, version, busy, setup, checkedAt, save, test }: { value: OssSettingsSummary | null; version: number; busy: boolean; setup: boolean; checkedAt: string | null; save: (body: SaveOssSettingsRequest) => Promise<boolean>; test: () => Promise<boolean> }) {
  const [accessKeyId, setId] = useState(""); const [accessKeySecret, setSecret] = useState("");
  const [bucket, setBucket] = useState(value?.bucket ?? ""); const [region, setRegion] = useState(value?.region ?? "cn-hangzhou");
  const [network, setNetwork] = useState<"public" | "internal">(value?.network ?? "public"); const [allowPublicNetwork, setAllow] = useState(value?.allowPublicNetwork ?? false);
  const [mediaBaseUrl, setMediaUrl] = useState(value?.mediaBaseUrl ?? ""); const [objectPrefix, setPrefix] = useState(value?.objectPrefix ?? "onlineVideo/");
  const [roleArn, setArn] = useState(value?.roleArn ?? "");
  const locked = !setup && !!value;
  const dirty = !value || !!accessKeyId || !!accessKeySecret || bucket !== value.bucket || region !== value.region || network !== value.network || allowPublicNetwork !== value.allowPublicNetwork || mediaBaseUrl !== value.mediaBaseUrl || objectPrefix !== value.objectPrefix || roleArn !== (value.roleArn ?? "");
  return <section className="panel stack" aria-label="OSS 配置"><h2>OSS 存储</h2><p className="muted">使用具备指定 Bucket/前缀权限的 RAM AccessKey。视频按公共读地址播放，站点登录不保护已公开的媒体地址。</p>{value && <div className="notice">当前凭据：{value.accessKeyIdMasked}；Secret {value.secretConfigured ? "已配置" : "未配置"}；{value.credentialMode === "role" ? "通过 ARN 扮演角色" : "直接凭据"}。{checkedAt && <> 只读检查：{date(checkedAt)}。</>}</div>}<form className="stack" onSubmit={async event => {
    event.preventDefault();
    const result = await save({ version, ...(accessKeyId ? { accessKeyId } : {}), ...(accessKeySecret ? { accessKeySecret } : {}), bucket: bucket.trim(), region: region.trim(), network, allowPublicNetwork, mediaBaseUrl: mediaBaseUrl.trim(), objectPrefix: objectPrefix.trim(), roleArn: roleArn.trim() });
    if (result) { setId(""); setSecret(""); }
  }}><fieldset disabled={busy}><div className="installation-grid"><label>AccessKeyId<input autoComplete="off" spellCheck={false} value={accessKeyId} onChange={event => setId(event.target.value)} required={!value?.secretConfigured || !!accessKeySecret} maxLength={256} /><small>{value?.secretConfigured ? "留空保留；更换时请同时填写 Secret。" : "首次配置必须填写。"}</small></label><label>AccessKeySecret<input type="password" autoComplete="new-password" value={accessKeySecret} onChange={event => setSecret(event.target.value)} required={!value?.secretConfigured || !!accessKeyId} maxLength={512} /><small>保存后不会显示原值。</small></label><label>Bucket 名称<input value={bucket} onChange={event => setBucket(event.target.value)} required maxLength={63} disabled={locked} /></label><label>Bucket 地域<input value={region} onChange={event => setRegion(event.target.value)} placeholder="例如 cn-hangzhou" required maxLength={64} disabled={locked} /></label><label>上传网络<select value={network} onChange={event => { setNetwork(event.target.value as "public" | "internal"); setAllow(false); }}><option value="public">公网</option><option value="internal">阿里云同地域内网</option></select><small>内网需要服务器实际可访问该地域内网，不会自动回退公网。</small></label><label>对象前缀<input value={objectPrefix} onChange={event => setPrefix(event.target.value)} required maxLength={512} disabled={locked} /><small>以 / 结尾，不移动既有对象。</small></label><label className="wide">媒体 HTTPS 地址<input type="url" value={mediaBaseUrl} onChange={event => setMediaUrl(event.target.value)} placeholder="https://你的媒体域名" required maxLength={2048} disabled={locked} /><small>浏览器直接播放使用的 HTTPS Origin，不是网站地址。</small></label><label className="wide">角色 ARN（可选）<input value={roleArn} onChange={event => setArn(event.target.value)} placeholder="acs:ram::账号ID:role/角色名" maxLength={512} spellCheck={false} /><small>填写后使用该角色的临时凭据，角色授权失败不会改用长期凭据绕过。</small></label>{network === "public" && <label className="installation-check wide"><input type="checkbox" checked={allowPublicNetwork} onChange={event => setAllow(event.target.checked)} required /><span>确认服务器通过 OSS 公网传输，可能产生公网流量费用。</span></label>}</div></fieldset>{locked && <small>启用后 Bucket、地域、媒体地址和对象前缀锁定，避免已有视频地址失效；其他修改的生效要求以服务器提示为准。</small>}<div className="installation-actions"><button disabled={busy || !dirty || network === "public" && !allowPublicNetwork}>保存 OSS 配置</button><button type="button" className="secondary" disabled={busy || !value || dirty} onClick={() => void test()}>测试 OSS 只读连通性</button></div>{dirty && value && <small>存在未保存修改，请先保存再测试。</small>}</form></section>;
}

function MailForms({ summary, busy, save, test }: { summary: InstallationSettingsSummary; busy: boolean; save: (body: SaveSmtpSettingsRequest) => Promise<boolean>; test: (provider: "qq" | "163", to: string) => Promise<boolean> }) {
  const [provider, setProvider] = useState<"qq" | "163">("qq");
  return <section className="panel stack" aria-label="邮件配置"><h2>邮件服务（可选）</h2><p className="muted">先保存配置，再发送测试邮件。单纯配置邮件不会开启登录邮箱验证；QQ 与 163 的发信配置分别保存。</p><label>邮箱服务类型<select value={provider} onChange={event => setProvider(event.target.value as "qq" | "163")} disabled={busy}><option value="qq">QQ 邮箱</option><option value="163">163 邮箱</option></select></label><MailForm key={`${provider}-${summary.version}`} provider={provider} value={summary.mail.find(item => item.providerCode === provider)} version={summary.version} busy={busy} save={save} test={to => test(provider, to)} /></section>;
}

function MailForm({ provider, value, version, busy, save, test }: { provider: "qq" | "163"; value: SmtpSettingsSummary | undefined; version: number; busy: boolean; save: (body: SaveSmtpSettingsRequest) => Promise<boolean>; test: (to: string) => Promise<boolean> }) {
  const [host, setHost] = useState(value?.host ?? `smtp.${provider}.com`); const [port, setPort] = useState(value?.port ?? 465);
  const [user, setUser] = useState(value?.user ?? ""); const [password, setPassword] = useState("");
  const [from, setFrom] = useState(value?.from ?? ""); const [to, setTo] = useState(value?.user ?? "");
  const [timeoutMs, setTimeout] = useState(value?.timeoutMs ?? 15000); const secure = port === 465;
  const dirty = !value || host !== value.host || port !== value.port || secure !== value.secure || user !== value.user || from !== value.from || timeoutMs !== value.timeoutMs || !!password;
  return <><form className="stack" onSubmit={async event => {
    event.preventDefault(); const result = await save({ version, providerCode: provider, host: host.trim(), port, secure, user: user.trim(), ...(password ? { password } : {}), from: from.trim(), timeoutMs });
    if (result) setPassword("");
  }}><fieldset disabled={busy}><div className="installation-grid"><label>SMTP 服务器<input value={host} onChange={event => setHost(event.target.value)} required maxLength={253} /><small>此类型使用 smtp.{provider}.com，不接受任意服务器地址。</small></label><label>端口与加密<select value={port} onChange={event => setPort(Number(event.target.value))}><option value={465}>465 · TLS</option><option value={587}>587 · STARTTLS</option></select></label><label>发信账号<input type="email" autoComplete="username" value={user} onChange={event => { const next = event.target.value; if (from === user) setFrom(next); setUser(next); }} required maxLength={254} placeholder={`name@${provider}.com`} /></label><label>SMTP 授权码<input type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} required={!value?.passwordConfigured} maxLength={512} /><small>{value?.passwordConfigured ? "已配置；留空保留原授权码。" : "不是邮箱登录密码，请填写提供商生成的 SMTP 授权码。"}</small></label><label>发件人地址<input type="email" value={from} onChange={event => setFrom(event.target.value)} required maxLength={254} /><small>须与该类型发信账号一致。</small></label><label>超时（毫秒）<input type="number" min={1000} max={60000} step={1000} value={timeoutMs} onChange={event => setTimeout(Number(event.target.value))} required /></label></div></fieldset><button disabled={busy || !dirty}>保存邮件配置</button></form><form className="stack" aria-label="发送测试邮件" onSubmit={event => { event.preventDefault(); void test(to.trim()); }}><label>测试收件邮箱<input type="email" value={to} onChange={event => setTo(event.target.value)} maxLength={254} required disabled={busy || !value || dirty} /></label><button className="secondary" disabled={busy || !value?.passwordConfigured || dirty || !to}>发送测试邮件</button><small>{dirty ? "请先保存当前邮件配置，测试只使用已保存的版本。" : value?.testedAt ? `最近 SMTP 接受时间：${date(value.testedAt)}；最终送达请在收件箱确认。` : "尚未测试。点击会发送一封真实邮件，不会自动开启邮箱验证。"}</small></form></>;
}
