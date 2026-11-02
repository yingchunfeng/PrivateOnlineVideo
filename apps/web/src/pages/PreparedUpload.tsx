import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { MAX_ORGANIZATION_LINKS } from "@online-video/shared";
import type { ApplicationLimits } from "@online-video/shared";
import { api, mockEnabled } from "../api";
import { useAuth } from "../auth";
import { loadLibrary, useLibraryRevision } from "../library";
import { defaultLibraryCategory, libraryTags } from "../library-data";
import { useUploadQueue } from "../upload-context";
import { bytes, ErrorNotice, Icon, Loading, Modal, TableContainer, useLoad } from "../ui";
import { useFeedback } from "../feedback";
import { UploadSources } from "../upload-sources";
import { CoverPicker } from "./CoverPicker";
import "./prepared-upload.css";
import { SatelliteIllustration } from "../space-console";
import { PublicRegisterPanel } from "../public-register";
import { useSiteSettingsRevision } from "../site-settings-sync";

const filesPerPage = () => {
  const height = window.innerHeight - (mockEnabled ? 62 : 0);
  return height < 690 ? 2 : height < 760 ? 3 : 4;
};
const TAGS_PER_PAGE = 4;

export function PreparedUploadPage() {
  const auth = useAuth(); const navigate = useNavigate(); const { queue, entries } = useUploadQueue();
  const libraryRevision = useLibraryRevision();
  const settingsRevision = useSiteSettingsRevision();
  const library = useLoad(loadLibrary, [libraryRevision]); const limits = useLoad(() => api.request<ApplicationLimits>("/api/settings/limits"), [settingsRevision]);
  const [selectedId, setSelectedId] = useState(""); const [submitting, setSubmitting] = useState(false);
  const [filePage, setFilePage] = useState(0); const [tagPage, setTagPage] = useState(0); const { toast } = useFeedback();
  const [pageSize, setPageSize] = useState(filesPerPage);
  const [showImport, setShowImport] = useState(false);
  const [importState, setImportState] = useState({ busy: false, canSubmit: false });
  const [coverPicker, setCoverPicker] = useState<{ id: string; opener: HTMLElement }>();
  useEffect(() => {
    const resize = () => {
      const size = filesPerPage(); const selectedIndex = entries.findIndex(entry => entry.clientId === selectedId);
      setPageSize(size); setFilePage(Math.floor(Math.max(0, selectedIndex) / size));
    };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [entries, selectedId]);
  const active = entries.find(entry => entry.clientId === selectedId) ?? entries[0];
  const coverTarget = entries.find(entry => entry.clientId === coverPicker?.id);
  const categories = library.data?.categories ?? []; const enabled = categories.filter(category => category.enabled !== false);
  const availableTags = libraryTags(enabled, active?.categoryId ?? "");
  const filePageCount = Math.max(1, Math.ceil(entries.length / pageSize)); const currentFilePage = Math.min(filePage, filePageCount - 1);
  const tagPageCount = Math.max(1, Math.ceil(availableTags.length / TAGS_PER_PAGE)); const currentTagPage = Math.min(tagPage, tagPageCount - 1);
  const visibleEntries = entries.slice(currentFilePage * pageSize, (currentFilePage + 1) * pageSize);
  const visibleTags = availableTags.slice(currentTagPage * TAGS_PER_PAGE, (currentTagPage + 1) * TAGS_PER_PAGE);
  const ready = entries.filter(entry => !entry.task && !entry.createRequest && !entry.validationError && entry.title.trim() && enabled.some(category => category.id === entry.categoryId));
  const add = (files: File[]) => { if (!limits.data || !library.data || submitting) return; const ids = queue.add(files, limits.data, defaultLibraryCategory(categories)); if (!active) setSelectedId(ids[0] ?? ""); toast(`已追加 ${ids.length} 个文件；每个文件独立校验和编辑。`, "info"); };
  const submit = async () => { if (!ready.length || submitting) return; setSubmitting(true); try { await queue.submit(ready.map(entry => entry.clientId)); if (auth.can("tasks")) navigate("/tasks"); } finally { setSubmitting(false); } };
  const editable = !!active && !active.createRequest && !active.task && !submitting;
  const changeFilePage = (page: number) => { setFilePage(page); setSelectedId(entries[page * pageSize]?.clientId ?? ""); setTagPage(0); };
  const preparationState = active?.validationError ? "校验失败" : active?.task ? "已提交" : active?.createRequest ? "创建失败" : active ? "待提交" : "待选择";
  return <div className="prepared-upload-page">
    <div className="upload-header-bar"><div className="upload-header-left">{auth.can("library") && <Link className="back-nav-btn" to="/"><Icon name="chevron" /><span>返回</span></Link>}<span className="header-divider">|</span><h1 className="upload-page-title">上传 / 编辑视频</h1></div><div className="upload-header-right"><div className="storage-chip"><div className="storage-chip-avatar"><Icon name="shield" /></div><div className="storage-chip-info"><span className="storage-chip-name">{auth.session?.user.displayName ?? "私有用户"}</span><span className="storage-chip-cap">单片限 {limits.data ? bytes(limits.data.maxUploadBytes) : "正在读取"}</span></div></div><div className="upload-submit-actions"><button className="secondary upload-import-trigger" disabled={submitting || library.busy || !library.data || !!library.error} onClick={() => { setImportState({ busy: false, canSubmit: false }); setShowImport(true); }}>导入已有视频</button><button className="save-action-btn" disabled={!ready.length || submitting || library.busy || !!library.error} onClick={() => void submit()}><Icon name="check" /><span>{submitting ? "正在创建任务…" : `提交 ${ready.length} 个视频并上传`}</span></button></div></div></div>
    <div className="notice warning compact-notice">逐项编辑后提交，{auth.can("tasks") ? "在任务列表查看进度" : "在本页下方查看本次上传进度"}；切换页面继续上传，刷新或关闭浏览器后需重新选择原文件。</div>
    {limits.error !== undefined && <ErrorNotice error={limits.error} retry={limits.reload} />}
    <div className="upload-sci-grid"><div className="upload-sci-left">
      <UploadSources count={entries.length} disabled={!limits.data || limits.busy || library.busy || !library.data || submitting} onFiles={add} />
      <div className="cover-preview-panel"><div className="cover-preview-header"><span>封面预览</span><span className="auto-gen-badge"><Icon name="sparkles" /><span>{active?.cover ? active.cover.source === "manual" ? "手动选择封面" : active.cover.source === "embedded" ? "视频自带封面" : "视频截帧" : active?.coverState === "working" ? "正在采集" : active?.coverState === "waiting" ? "等待采集" : "暂无封面"}</span></span></div><div className="cover-preview-thumbs single-cover"><div className="cover-thumb-item active"><div className={`cover-thumb-inner ${active?.cover ? "" : "placeholder"}`}>{active?.cover ? <img src={active.cover.url} alt={`${active.title}的本地封面`} className="local-cover-image" /> : <><Icon name="play" /><span>暂无封面</span></>}</div></div></div>{active?.coverError && <small className="muted">{active.coverError}；不会阻止视频上传或播放。</small>}<small className="muted">{active?.cover?.source === "manual" ? `已选 ${active.manualCoverTime?.toFixed(1)} 秒画面；可在列表中重新选择。` : "优先使用视频内嵌封面，否则自动截帧；可在列表中手动选择封面。"}</small></div>
    </div><div className="upload-sci-right">
      <section className="sci-form-panel upload-information-panel" aria-label="基本信息和文件信息"><div className="upload-panel-heading"><h2 className="sci-section-title">基本信息与文件信息</h2><span className={`upload-preparation-state ${active?.validationError ? "invalid" : ""}`} role="status">{preparationState}</span></div>
        <div className="upload-metadata-fields"><div className="sci-field-group"><label className="sci-field-label"><span>标题</span><input className="sci-input" aria-label="视频标题" value={active?.title ?? ""} placeholder="输入视频标题" maxLength={200} required disabled={!editable} onChange={event => active && queue.edit(active.clientId, { title: event.target.value })} /></label></div>
        <div className="sci-field-group"><label className="sci-field-label"><span>分类</span><div className="sci-select-wrapper"><select className="sci-select" aria-label="视频分类" value={active?.categoryId ?? defaultLibraryCategory(categories)} disabled={!editable || library.busy} onChange={event => { if (active) queue.edit(active.clientId, { categoryId: event.target.value, tags: [] }); setTagPage(0); }}>{enabled.length === 0 && <option value="">请先配置分类</option>}{active?.categoryId && !enabled.some(category => category.id === active.categoryId) && <option value={active.categoryId}>原分类已停用，请重新选择</option>}{enabled.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select><Icon name="chevron" /></div></label></div></div>
        <div className="sci-field-group upload-tag-field"><div className="sci-field-label"><div className="upload-tag-heading"><span>标签 <small className="muted">已选 {active?.tags.length ?? 0} 项</small></span>{tagPageCount > 1 && <nav className="upload-tag-pagination" aria-label="标签分页"><button type="button" className="secondary" aria-label="上一页标签" disabled={currentTagPage === 0} onClick={() => setTagPage(currentTagPage - 1)}>‹</button><small>{currentTagPage + 1} / {tagPageCount}</small><button type="button" className="secondary" aria-label="下一页标签" disabled={currentTagPage === tagPageCount - 1} onClick={() => setTagPage(currentTagPage + 1)}>›</button></nav>}</div><div className="tag-chips-matrix">{visibleTags.map(tag => <button key={tag} type="button" title={tag} className={`tag-chip ${active?.tags.includes(tag) ? "active" : ""}`} aria-label={tag} aria-pressed={active?.tags.includes(tag) ?? false} disabled={!editable || !active?.tags.includes(tag) && (active?.tags.length ?? 0) >= MAX_ORGANIZATION_LINKS} onClick={() => active && queue.edit(active.clientId, { tags: active.tags.includes(tag) ? active.tags.filter(value => value !== tag) : [...active.tags, tag] })}><span className="upload-tag-name">{tag}</span>{active?.tags.includes(tag) && <span className="chip-x">×</span>}</button>)}{!availableTags.length && <small>此分类暂无配置标签。</small>}</div></div></div>
        <button type="button" className="secondary upload-apply-metadata" disabled={!editable || !active?.categoryId} onClick={() => { if (active) { queue.applyMetadata(active.clientId); toast("已将当前分类和标签应用到全部待提交视频，各自标题保持原值。"); } }}>将当前分类和标签应用到全部待提交视频</button>
        <div className="upload-file-details"><span className="upload-file-name" title={active?.fileName ?? "尚未选择文件"}><span className="spec-label">文件名</span> {active?.fileName ?? "尚未选择文件"}</span><span className="upload-file-size"><span className="spec-label">大小</span> {active ? bytes(active.sizeBytes) : "—"}</span></div>
        {active?.validationError && <div className="notice error upload-validation-notice" role="alert">{active.validationError}。其他合法文件可继续提交。</div>}
        {library.busy && <Loading />}{library.error !== undefined && <ErrorNotice error={library.error} retry={library.reload} />}
      </section>
      <section className="cover-preview-panel pending-upload-panel" aria-label="待上传列表"><div className="cover-preview-header"><span>待上传列表 <small className="muted">{entries.length} 项 · {ready.length} 项可提交</small></span>{auth.can("tasks") && <Link className="text-link" to="/tasks">前往任务列表</Link>}</div>{entries.length === 0 ? <div className="pending-upload-empty"><SatelliteIllustration /><small>选择视频文件或文件夹后，在这里切换并逐项编辑。</small></div> : <><div className="pending-upload-list">{visibleEntries.map(entry => <div key={entry.clientId} className={`pending-upload-row ${active?.clientId === entry.clientId ? "active" : ""}`} data-client-id={entry.clientId}><button type="button" className="pending-upload-choice" aria-pressed={active?.clientId === entry.clientId} title={entry.validationError ?? entry.fileName} onClick={() => { setSelectedId(entry.clientId); setTagPage(0); }}>{entry.cover ? <img src={entry.cover.url} alt="" /> : <span className="pending-cover-placeholder"><Icon name="play" /></span>}<span className="pending-upload-description"><span className="pending-upload-title"><strong title={entry.title || entry.fileName}>{entry.title || entry.fileName}</strong><small className={entry.validationError ? "pending-upload-invalid" : ""}>{entry.validationError ? "校验失败" : entry.task ? "已提交" : entry.createRequest ? "创建失败" : entry.coverState === "working" ? "封面采集中" : entry.cover?.source === "manual" ? "手动封面" : "待提交"}</small></span><small className="pending-upload-file" title={entry.fileName}>{entry.fileName} · {bytes(entry.sizeBytes)}</small></span></button><div className="pending-upload-actions"><button className="secondary pending-upload-cover" type="button" disabled={submitting || !entry.file || !!entry.validationError || !!entry.createRequest || !!entry.task} onClick={event => { setSelectedId(entry.clientId); setTagPage(0); setCoverPicker({ id: entry.clientId, opener: event.currentTarget }); }}>选择封面</button>{!entry.createRequest && !entry.task ? <button className="secondary pending-upload-remove" type="button" aria-label={`移出待选 ${entry.fileName}`} disabled={submitting} onClick={() => queue.remove(entry.clientId)}>移出</button> : auth.can("tasks") ? <Link className="text-link" to="/tasks">任务</Link> : <span className="muted">{entry.state === "completed" ? "上传完成" : "下方查看进度"}</span>}</div></div>)}</div><nav className="pending-upload-pagination" aria-label="待上传视频分页"><span aria-live="polite">第 {currentFilePage + 1} / {filePageCount} 页</span><div><button className="secondary" type="button" disabled={currentFilePage === 0} onClick={() => changeFilePage(currentFilePage - 1)}>上一页</button><button className="secondary" type="button" disabled={currentFilePage === filePageCount - 1} onClick={() => changeFilePage(currentFilePage + 1)}>下一页</button></div></nav></>}</section>
    </div></div>
    {coverPicker && coverTarget?.file && !coverTarget.validationError && !coverTarget.createRequest && !coverTarget.task && <CoverPicker key={coverTarget.clientId} file={coverTarget.file} title={coverTarget.title || coverTarget.fileName} initialTime={coverTarget.manualCoverTime} opener={coverPicker.opener} onCommit={(cover, time) => queue.setCover(coverTarget.clientId, cover, time)} onClose={() => setCoverPicker(undefined)} />}
    {showImport && library.data && <Modal title="导入已有视频" className="upload-import-dialog" busy={importState.busy} onClose={() => setShowImport(false)} footer={<><button className="secondary" disabled={importState.busy} onClick={() => setShowImport(false)}>关闭</button><button form="upload-import-form" type="submit" disabled={importState.busy || !importState.canSubmit}>{importState.busy ? "正在登记…" : "登记公开视频"}</button></>}><PublicRegisterPanel library={library.data} formId="upload-import-form" onStateChange={setImportState} onImported={library.reload} /></Modal>}
    {!auth.can("tasks") && <UploadExecutionSummary />}
  </div>;
}

function UploadExecutionSummary() {
  const { entries, queue } = useUploadQueue();
  const submitted = entries.filter(entry => entry.task || entry.createRequest);
  if (!submitted.length) return null;
  return <section className="stack section-space" aria-label="本次上传进度"><h2>本次上传进度</h2><p className="muted">仅展示本次登录创建的任务。未授予任务列表权限，不会读取其他任务。</p><TableContainer label="本次上传进度"><table className="management-table"><thead><tr><th scope="col">视频</th><th scope="col">状态 / 进度</th><th scope="col">操作</th></tr></thead><tbody>{submitted.map(entry => {
    const uploaded = entry.task?.uploadedParts.reduce((sum, part) => sum + part.sizeBytes, 0) ?? 0;
    const percent = Math.min(100, Math.floor(uploaded / entry.sizeBytes * 100));
    const working = ["queued", "creating", "uploading", "verifying", "confirming", "savingCover"].includes(entry.state);
    return <tr key={entry.clientId}><td>{entry.title}</td><td><span role="status">{entry.state === "completed" ? "上传已完成" : working ? "正在上传 / 保存" : entry.state === "paused" ? "已暂停" : "等待重试"} · {percent}%</span><progress value={percent} max={100} aria-label={`${entry.title} 上传进度`} />{entry.error !== undefined && <ErrorNotice error={entry.error} />}</td><td>{working ? <button className="secondary" onClick={() => queue.pause(entry.clientId)}>暂停上传</button> : entry.state !== "completed" && <button onClick={() => queue.retry(entry.clientId)}>继续 / 重试上传</button>}</td></tr>;
  })}</tbody></table></TableContainer></section>;
}
