import { useEffect, useRef, useState } from "react";
import type { SiteSettings } from "@online-video/shared";
import { api } from "../api";
import { ApiError } from "../api/client";
import { notifySiteSettingsChanged } from "../site-settings-sync";
import { bytes, ErrorNotice, Loading, useLoad } from "../ui";
import "./page-management.css";

const GIB = 1073741824;
export function UploadLimitSettings() {
  const load = useLoad(() => api.request<SiteSettings>("/api/settings/site"));
  const [site, setSite] = useState<SiteSettings>(); const [draft, setDraft] = useState("");
  const [error, setError] = useState<unknown>(); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState("");
  const saving = useRef(false);
  useEffect(() => { if (load.data && !site) { setSite(load.data); setDraft(String(load.data.maxUploadBytes / GIB)); } }, [load.data, site]);
  const inputBytes = draft.trim() ? Math.round(Number(draft) * GIB) : NaN;
  const valid = !!site && Number.isFinite(Number(draft)) && Number.isSafeInteger(inputBytes) && inputBytes > 0 && inputBytes <= site.maxConfigurableUploadBytes;
  const refreshVersion = async () => {
    if (saving.current) return;
    saving.current = true; setBusy(true);
    try { setSite(await api.request<SiteSettings>("/api/settings/site")); setError(undefined); }
    catch (failure) { setError(failure); }
    finally { saving.current = false; setBusy(false); }
  };
  const save = async () => {
    if (!site || !valid || saving.current || !site.persistenceAvailable) return;
    saving.current = true; setBusy(true); setError(undefined); setNotice("");
    try {
      const next = await api.request<SiteSettings>("/api/settings/site", { method: "PATCH", body: { version: site.version, maxUploadBytes: inputBytes } });
      setSite(next); setDraft(String(next.maxUploadBytes / GIB)); notifySiteSettingsChanged(); setNotice("单文件上限已保存，对新建上传任务生效；已创建任务继续使用原快照，不取消任务或删除已有视频。");
    } catch (failure) { setError(failure); }
    finally { saving.current = false; setBusy(false); }
  };
  return <section className="panel stack" aria-label="上传限制"><h2>上传限制</h2><p className="muted">统一设置单个视频文件最大值。1 GiB = 1,073,741,824 字节，不提供不限额模式。</p>
    {!site && load.busy ? <Loading /> : !site ? <ErrorNotice error={load.error ?? new Error("上传限制尚未加载")} retry={load.reload} /> : <>
      <div className="upload-limit-value"><strong>当前上限：{bytes(site.maxUploadBytes)}</strong><small>{site.maxUploadBytes.toLocaleString("zh-CN")} 字节 · 配置版本 {site.version}</small></div>
      {!site.persistenceAvailable && <div className="notice warning" role="status">尚未启用站点配置持久化。需要管理员核对数据库目标并授权迁移后保存；不会自动升级或覆盖现有配置。</div>}
      <form className="management-form upload-limit-form" onSubmit={event => { event.preventDefault(); void save(); }}><label className="management-field"><span id="upload-limit-label">单个视频文件最大值（GiB）</span><input type="number" min={1 / GIB} max={site.maxConfigurableUploadBytes / GIB} step="any" inputMode="decimal" required value={draft} disabled={busy || !site.persistenceAvailable} onChange={event => { setDraft(event.target.value); setNotice(""); }} aria-labelledby="upload-limit-label" aria-describedby="upload-limit-help" /><small id="upload-limit-help">最大可配置 {bytes(site.maxConfigurableUploadBytes)}（{site.maxConfigurableUploadBytes.toLocaleString("zh-CN")} 字节），由当前分片大小 {bytes(site.partSizeBytes)} × 10,000 片约束。输入按字节取整。</small></label>
        {!valid && <p className="management-field-error" role="alert">请输入大于 0 且不超过分片约束上界的有限数值。</p>}
        {error !== undefined && <ErrorNotice error={error} />}{error instanceof ApiError && error.code === "CONFIG_VERSION_CONFLICT" && <div className="notice warning"><p>配置版本已变化，输入仍保留。读取最新版本后请再次保存。</p><button type="button" className="secondary" disabled={busy} onClick={() => void refreshVersion()}>使用最新版本重试</button></div>}
        <div><button disabled={busy || !valid || !site.persistenceAvailable || inputBytes === site.maxUploadBytes}>{busy ? "正在保存…" : "保存单文件上限"}</button></div>
      </form>{notice && <div className="notice" role="status">{notice}</div>}
      <small>降低上限不改变已有视频，不取消原有上传任务，也不清理 OSS；新建任务使用最新上限，恢复任务按创建时的文件大小与分片快照继续。</small>
    </>}
  </section>;
}
