import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { ApplicationLimits, CreateUploadRequest, UploadTask, VideoDetail } from "@online-video/shared";
import { api, mockEnabled } from "../api";
import { useAuth } from "../auth";
import { bytes, date, ErrorNotice, Icon, Loading, useLoad } from "../ui";
import { completeTask, readUploadHints, rememberUpload, uploadFile, uploadHintKey, validateTask, validateUploadSize } from "../upload";
import { loadLibrary } from "../library";
import { defaultLibraryCategory, libraryTags } from "../library-data";
import { PublicAddress } from "../public-address";

const taskStatus = { uploading: "等待上传或可续传", finalizing: "服务端正在确认完整视频", completed: "服务端已确认并登记", failed: "服务端任务失败" };

export { PreparedUploadPage as UploadPage } from "./PreparedUpload";

export function LegacyUploadPage() {
  const auth = useAuth();
  const key = uploadHintKey(auth.session?.user.id ?? "", mockEnabled);
  const organizations = useLoad(loadLibrary);
  const limits = useLoad(() => api.request<ApplicationLimits>("/api/settings/limits"));
  const [hints, setHints] = useState(() => readUploadHints(key));
  const [file, setFile] = useState<File>(); const [title, setTitle] = useState(""); const [category, setCategory] = useState("");
  const [tags, setTags] = useState<string[]>([]); const [completedVideo, setCompletedVideo] = useState<VideoDetail>();
  const [task, setTask] = useState<UploadTask>(); const [busy, setBusy] = useState(false); const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<unknown>(); const [paused, setPaused] = useState(false); const [verifying, setVerifying] = useState("");
  const [storageError, setStorageError] = useState(""); const controller = useRef<AbortController | undefined>(undefined); const alive = useRef(true); const running = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); }; }, []);
  const update = (value: UploadTask) => { if (alive.current) setTask({ ...value, uploadedParts: [...value.uploadedParts] }); };

  const run = async () => {
    if (!file || running.current || !limits.data) return;
    try { validateUploadSize(file.size, limits.data); } catch (err) { setError(err); return; }
    running.current = true; const abort = new AbortController(); controller.current = abort;
    setBusy(true); setError(undefined); setPaused(false); setVerifying("正在读取服务端状态…");
    try {
      let active = task;
      if (!active) {
        active = await api.request<UploadTask>("/api/uploads", { method: "POST", body: { fileName: file.name, sizeBytes: file.size, title: title.trim(), categoryId: category || defaultLibraryCategory(organizations.data?.categories ?? []), tags } satisfies CreateUploadRequest, signal: abort.signal });
        validateTask(active, file); update(active);
        try { rememberUpload(key, active); if (alive.current) setHints(readUploadHints(key)); } catch { if (alive.current) setStorageError("浏览器未允许保存任务提示；请记录上传任务 ID，重开页面后手动读取。"); }
      }
      if (alive.current) setVerifying("逐片核对已完成数据…");
      const result = await uploadFile(api, file, active, abort.signal, value => { update(value); if (alive.current && value.uploadedParts.length > 0) setVerifying(""); }, part => { if (alive.current) setVerifying(`已核对第 ${part} 个完成分片`); });
      if (alive.current) setCompletedVideo(result.video);
    } catch (err) {
      if (alive.current) { if (err instanceof DOMException && err.name === "AbortError") setPaused(true); else setError(err); }
    } finally { running.current = false; if (alive.current) { setBusy(false); setVerifying(""); } }
  };

  const loadTask = async (id: string) => {
    if (busy || fetching || !id.trim()) return;
    setFetching(true); setError(undefined); setFile(undefined); setTask(undefined); setCompletedVideo(undefined);
    try { const active = await api.request<UploadTask>(`/api/uploads/${encodeURIComponent(id.trim())}`); validateTask(active); update(active); setTitle(active.title ?? ""); setCategory(active.categoryId ?? ""); setTags(active.tags ?? []); setPaused(true); if (active.status === "completed" && active.videoId) { const video = await api.request<VideoDetail>(`/api/videos/${encodeURIComponent(active.videoId)}`); if (alive.current) setCompletedVideo(video); } }
    catch (err) { if (alive.current) setError(err); } finally { if (alive.current) setFetching(false); }
  };

  const uploaded = task?.uploadedParts.reduce((sum, part) => sum + part.sizeBytes, 0) ?? 0;
  const canUpload = !busy && !fetching && !!file && file.size > 0 && !!limits.data && !limits.busy && !limits.error && !organizations.busy && !organizations.error && (task ? task.status === "uploading" : !!title.trim() && (category || defaultLibraryCategory(organizations.data?.categories ?? [])));
  const [manualId, setManualId] = useState("");

  const categories = organizations.data?.categories ?? [];
  const availableTags = libraryTags(categories, category || defaultLibraryCategory(categories));

  return <>
    {/* 顶部科技导航栏 */}
    <div className="upload-header-bar">
      <div className="upload-header-left">
        <Link className="back-nav-btn" to="/">
          <Icon name="chevron" />
          <span>返回</span>
        </Link>
        <span className="header-divider">|</span>
        <h1 className="upload-page-title">上传 / 编辑视频</h1>
      </div>
      <div className="upload-header-right">
        <div className="storage-chip">
          <div className="storage-chip-avatar"><Icon name="shield" /></div>
          <div className="storage-chip-info">
            <span className="storage-chip-name">{auth.session?.user.displayName ?? "私有用户"}</span>
            <span className="storage-chip-cap">单片限 {limits.data ? bytes(limits.data.maxUploadBytes) : "2.0 GiB"}</span>
          </div>
        </div>
        <button
          className="save-action-btn"
          disabled={!canUpload}
          onClick={() => void run()}
        >
          <Icon name="check" />
          <span>{busy ? "正在上传…" : task ? (error ? "核对后重试" : "核对续传") : "保存并上传"}</span>
        </button>
      </div>
    </div>

    {/* 提示信息 */}
    <div className="notice warning compact-notice">
      <strong>提示：</strong>上传时请保持页面在前台，中断后可重新选择同一视频原文件校验续传。
    </div>
    {mockEnabled && <div className="notice compact-notice" role="status">开发 Mock · 验证分片与传输状态</div>}
    {storageError && <div className="notice warning compact-notice">{storageError}</div>}
    {error !== undefined && <ErrorNotice error={error} />}

    {/* 双栏科技主体布局 */}
    <div className="upload-sci-grid">
      {/* 左侧：科技脉冲上传仓 & 封面 */}
      <div className="upload-sci-left">
        <div
          className={`radar-dropzone ${file ? "has-file" : ""} ${busy ? "uploading" : ""}`}
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            key={task?.id ?? "new"}
            type="file"
            aria-label="视频文件"
            className="visually-hidden-file"
            accept="video/*,.mp4,.mov,.webm,.mkv,.m4v"
            disabled={busy || fetching || limits.busy || !limits.data || task?.status === "completed" || task?.status === "finalizing"}
            onChange={event => {
              const chosen = event.target.files?.[0];
              setError(undefined);
              if (chosen && limits.data) {
                try { validateUploadSize(chosen.size, limits.data); }
                catch (err) { setFile(undefined); setError(err); return; }
              }
              setFile(chosen);
              if (!task && chosen) setTitle(chosen.name.replace(/\.[^.]+$/, ""));
            }}
          />
          <div className="radar-scanner-circle">
            <div className="radar-pulse-ring" />
            <div className="radar-pulse-ring delay" />
            <div className="radar-icon-center">
              <Icon name="cloud-upload" />
            </div>
          </div>
          <div className="radar-text-group">
            <h3>{file ? file.name : "拖拽视频文件到这里"}</h3>
            <p className="radar-subtext">{file ? `${bytes(file.size)} · 点击更换原文件` : "或点击浏览文件"}</p>
            <p className="radar-spec-note">支持格式：MP4 / MOV / WEBM / MKV</p>
          </div>
        </div>

        {/* 封面预览区 */}
        <div className="cover-preview-panel">
          <div className="cover-preview-header">
            <span>封面预览</span>
            <span className="auto-gen-badge">
              <Icon name="sparkles" />
            <span>待采集</span>
            </span>
          </div>
          <div className="cover-preview-thumbs">
            <div className="cover-thumb-item active">
              <div className="cover-thumb-inner placeholder">
                <Icon name="play" />
                <span className="cover-thumb-tag">占位</span>
              </div>
            </div>
            <div className="cover-thumb-item">
              <div className="cover-thumb-inner placeholder alt1">
                <span>暂无封面</span>
              </div>
            </div>
            <div className="cover-thumb-item">
              <div className="cover-thumb-inner placeholder alt2">
                <span>暂无封面</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 右侧：表单配置与文件元数据 */}
      <div className="upload-sci-right">
        <section className="sci-form-panel">
          <div className="sci-section-title">基本信息</div>
          <div className="sci-field-group">
            <label className="sci-field-label">
              <span>标题</span>
              <input
                className="sci-input"
                aria-label="视频标题"
                placeholder="输入视频标题"
                value={title}
                onChange={event => setTitle(event.target.value)}
                maxLength={200}
                required
                disabled={busy || !!task}
              />
            </label>
          </div>

          <div className="sci-field-group">
            <label className="sci-field-label">
              <span>分类</span>
              <div className="sci-select-wrapper">
                <select
                  className="sci-select"
                  aria-label="视频分类"
                  value={category || defaultLibraryCategory(categories)}
                  onChange={event => { setCategory(event.target.value); setTags([]); }}
                  disabled={busy || organizations.busy || !!task}
                >
                  {!defaultLibraryCategory(categories) && <option value="">请先配置分类</option>}
                  {categories.map(c => (
                    <option key={c.id} value={c.id} disabled={c.enabled === false}>
                      {c.name}{c.enabled === false ? "（已停用）" : ""}
                    </option>
                  ))}
                </select>
                <Icon name="chevron" />
              </div>
            </label>
          </div>

          <div className="sci-field-group">
            <label className="sci-field-label">
              <span>标签</span>
              <div className="tag-chips-matrix">
                {availableTags.map(t => {
                  const isChecked = tags.includes(t);
                  return (
                    <button
                      type="button"
                      key={t}
                      aria-label={t}
                      aria-pressed={isChecked}
                      disabled={busy || !!task}
                      className={`tag-chip ${isChecked ? "active" : ""}`}
                      onClick={() => {
                        if (busy) return;
                        setTags(isChecked ? tags.filter(tag => tag !== t) : [...tags, t]);
                      }}
                    >
                      <span>{t}</span>
                      {isChecked && <span className="chip-x">×</span>}
                    </button>
                  );
                })}
                {availableTags.length === 0 && <small>此分类暂无配置标签。</small>}
              </div>
            </label>
          </div>

          {/* 表单数据统一使用上方可见字段。 */}
          <div style={{ display: "none" }}>
            <small>分类与标签来自视频库配置。</small>
          </div>
          {organizations.busy && <Loading />}
          {organizations.error !== undefined && <ErrorNotice error={organizations.error} retry={organizations.reload} />}
        </section>

        {/* 文件信息 / 任务进度信息面板 */}
        <section className="sci-form-panel">
          <div className="sci-section-title">文件信息</div>
          <div className="sci-file-specs">
            <div className="spec-row">
              <span className="spec-label">文件名</span>
              <span className="spec-value">{file?.name ?? (task?.fileName ?? "尚未选择文件")}</span>
            </div>
            <div className="spec-row">
              <span className="spec-label">文件大小</span>
              <span className="spec-value">{file ? bytes(file.size) : (task ? bytes(task.sizeBytes) : "—")}</span>
            </div>
            <div className="spec-row">
              <span className="spec-label">传输状态</span>
              <span className="spec-value accent">{task ? taskStatus[task.status] : (file ? "就绪，等待上传" : "待选择")}</span>
            </div>
            {task && (
              <div className="spec-row">
                <span className="spec-label">任务编号</span>
                <span className="spec-value code">{task.id}</span>
              </div>
            )}
          </div>

          {/* 上传进度显示 */}
          {task && (
            <div className="upload-progress-box">
              <div className="progress-info-row">
                <span>传输进度</span>
                <span className="progress-pct">{Math.floor(uploaded / task.sizeBytes * 100)}%</span>
              </div>
              <div className="neon-progress-bar">
                <div className="neon-progress-fill" style={{ width: `${Math.floor(uploaded / task.sizeBytes * 100)}%` }} />
              </div>
              <div className="progress-sub-row">
                <small>{bytes(uploaded)} / {bytes(task.sizeBytes)}</small>
                <small>{paused && !busy && task.status === "uploading" ? "已暂停，可校验续传" : taskStatus[task.status]}</small>
              </div>
            </div>
          )}

          {verifying && <p className="sci-verifying-text" role="status">{verifying}</p>}

          {task?.status === "completed" && task.videoId && (
            <div className="notice completed-sci-notice" role="status">
              <strong>{mockEnabled ? "模拟服务端已确认登记" : "服务端已确认登记"}</strong>
              <p>视频已保存，可交给浏览器直接尝试播放。</p>
              <Link className="button" to={`/videos/${encodeURIComponent(task.videoId)}`}>播放视频</Link>
              {completedVideo && <PublicAddress publicUrl={completedVideo.publicUrl} />}
            </div>
          )}
          {task?.status === "finalizing" && <div className="notice">等待服务端完成校验；请刷新任务确认结果，勿重复创建。</div>}

          {/* 任务控制操作按钮行 */}
          <div className="sci-actions-group">
            <button
              className="button"
              disabled={!canUpload}
              onClick={() => void run()}
            >
              {busy ? "正在上传…" : task ? (error ? "核对后重试" : "核对并继续上传") : "开始分片上传"}
            </button>
            {busy && (
              <button className="secondary" onClick={() => { controller.current?.abort(); setPaused(true); }}>
                暂停上传
              </button>
            )}
            {task && !busy && (
              <button className="secondary" disabled={fetching} onClick={() => void loadTask(task.id)}>
                刷新服务端任务
              </button>
            )}
            {task && !busy && (
              <button className="secondary" onClick={() => { setTask(undefined); setCompletedVideo(undefined); setFile(undefined); setTitle(""); setTags([]); setError(undefined); setPaused(false); }}>
                上传另一个视频
              </button>
            )}
            {task && task.status !== "completed" && task.uploadedParts.length === Math.ceil(task.sizeBytes / task.partSizeBytes) && (
              <button className="secondary" disabled={busy || fetching} onClick={async () => {
                setFetching(true); setError(undefined);
                try { const result = await completeTask(api, task); update(result.upload); if (alive.current) setCompletedVideo(result.video); }
                catch (err) { if (alive.current) setError(err); } finally { if (alive.current) setFetching(false); }
              }}>
                {fetching ? "正在确认…" : "重试服务端完成确认"}
              </button>
            )}
          </div>
          {task?.status === "uploading" && !file && (
            <small className="muted">请重新选择原文件。系统将核对大小及每个已完成分片的 SHA-256，文件名相同不能作为续传依据。</small>
          )}
        </section>
      </div>
    </div>

    {/* 底部：恢复已有任务栏 */}
    <section className="panel section-space stack sci-tasks-history">
      <h2>恢复已有任务</h2>
      <p className="muted">此处仅保存任务提示，不保存视频字节、Cookie 或敏感凭证。读取和续传仍需服务端鉴权。</p>
      {hints.length === 0 ? (
        <small>此浏览器还没有任务提示。</small>
      ) : (
        <div className="hint-list">
          {hints.map(hint => (
            <button className="secondary hint-row" key={hint.id} disabled={busy || fetching} onClick={() => void loadTask(hint.id)}>
              <span>{hint.fileName}<small>{bytes(hint.sizeBytes)} · {date(hint.createdAt)}</small><small>{hint.id}</small></span>
              <span>读取任务</span>
            </button>
          ))}
        </div>
      )}
      <form className="stack" onSubmit={event => { event.preventDefault(); void loadTask(manualId); }}>
        <label>或输入已知上传任务 ID
          <input value={manualId} onChange={event => setManualId(event.target.value)} maxLength={256} disabled={busy || fetching} />
        </label>
        <button className="secondary" type="submit" disabled={busy || fetching || !manualId.trim()}>读取服务端任务</button>
      </form>
    </section>
  </>;
}
