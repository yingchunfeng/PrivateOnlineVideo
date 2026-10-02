import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { Category, UploadTask } from "@online-video/shared";
import { api, mockEnabled } from "../api";
import { useAuth } from "../auth";
import { bytes, date, ErrorNotice, Loading, useLoad } from "../ui";
import { completeTask, readUploadHints, rememberUpload, uploadFile, uploadHintKey, validateTask } from "../upload";

const taskStatus = { uploading: "等待上传或可续传", finalizing: "服务端正在确认完整视频", completed: "服务端已确认并登记", failed: "服务端任务失败" };
export function UploadPage() {
  const auth = useAuth();
  const key = uploadHintKey(auth.session?.user.id ?? "", mockEnabled);
  const categories = useLoad(() => api.request<Category[]>("/api/categories"));
  const [hints, setHints] = useState(() => readUploadHints(key));
  const [file, setFile] = useState<File>(); const [title, setTitle] = useState(""); const [category, setCategory] = useState("");
  const [task, setTask] = useState<UploadTask>(); const [busy, setBusy] = useState(false); const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<unknown>(); const [paused, setPaused] = useState(false); const [verifying, setVerifying] = useState("");
  const [storageError, setStorageError] = useState(""); const controller = useRef<AbortController | undefined>(undefined); const alive = useRef(true); const running = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); }; }, []);
  const update = (value: UploadTask) => { if (alive.current) setTask({ ...value, uploadedParts: [...value.uploadedParts] }); };
  const run = async () => {
    if (!file || running.current) return;
    running.current = true; const abort = new AbortController(); controller.current = abort;
    setBusy(true); setError(undefined); setPaused(false); setVerifying("正在读取服务端状态…");
    try {
      let active = task;
      if (!active) {
        active = await api.request<UploadTask>("/api/uploads", { method: "POST", body: { fileName: file.name, sizeBytes: file.size, title: title.trim(), categoryId: category || categories.data?.[0]?.id }, signal: abort.signal });
        validateTask(active, file); update(active);
        try { rememberUpload(key, active); if (alive.current) setHints(readUploadHints(key)); } catch { if (alive.current) setStorageError("浏览器未允许保存任务提示；请记录上传任务 ID，重开页面后手动读取。"); }
      }
      if (alive.current) setVerifying("逐片核对已完成数据…");
      await uploadFile(api, file, active, abort.signal, value => { update(value); if (alive.current && value.uploadedParts.length > 0) setVerifying(""); }, part => { if (alive.current) setVerifying(`已核对第 ${part} 个完成分片`); });
    } catch (err) {
      if (alive.current) { if (err instanceof DOMException && err.name === "AbortError") setPaused(true); else setError(err); }
    } finally { running.current = false; if (alive.current) { setBusy(false); setVerifying(""); } }
  };
  const loadTask = async (id: string) => {
    if (busy || fetching || !id.trim()) return;
    setFetching(true); setError(undefined); setFile(undefined); setTask(undefined);
    try { const active = await api.request<UploadTask>(`/api/uploads/${encodeURIComponent(id.trim())}`); validateTask(active); update(active); setPaused(true); }
    catch (err) { if (alive.current) setError(err); } finally { if (alive.current) setFetching(false); }
  };
  const uploaded = task?.uploadedParts.reduce((sum, part) => sum + part.sizeBytes, 0) ?? 0;
  const canUpload = !busy && !fetching && !!file && file.size > 0 && (task ? task.status === "uploading" : !!title.trim() && (category || categories.data?.[0]?.id));
  const [manualId, setManualId] = useState("");
  return <>
    <div className="eyebrow">FROM YOUR PHONE, TO YOUR SPACE</div><h1>上传视频</h1><p className="muted">逐片上传原视频，中断后可重新选择文件并核对续传。</p>
    <div className="notice warning"><strong>上传时请保持页面在前台</strong><p>安卓锁屏、切换后台或浏览器回收页面可能中断上传。暂停不会清理已上传分片，重新打开时需要再次选择原文件。</p></div>
    {mockEnabled && <div className="notice" role="status">开发 Mock 仅验证分片和页面状态，不写 OSS。模拟完成的视频保持“处理中”，不代表真实视频格式验证通过。</div>}
    {storageError && <div className="notice warning">{storageError}</div>}
    <section className="panel stack"><h2>{task ? "上传任务" : "选择手机视频"}</h2>
      <label>{task ? "重新选择原文件" : "视频文件"}<input key={task?.id ?? "new"} type="file" accept="video/*,.mp4,.mov,.webm,.mkv,.m4v" disabled={busy || fetching || task?.status === "completed" || task?.status === "finalizing"} onChange={event => { const chosen = event.target.files?.[0]; setFile(chosen); setError(undefined); if (!task && chosen) setTitle(chosen.name.replace(/\.[^.]+$/, "")); }} /><small>文件扩展名不代表可播放；兼容状态由后端元数据检查确定。</small></label>
      {file && <div className="file-summary"><strong>{file.name}</strong><small>{bytes(file.size)} · 此页只逐片读取文件</small></div>}
      {!task && <><label>视频标题<input value={title} onChange={event => setTitle(event.target.value)} maxLength={200} required disabled={busy} /></label><label>视频分类<select value={category || categories.data?.[0]?.id || ""} onChange={event => setCategory(event.target.value)} disabled={busy || categories.busy}>{categories.data?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>{categories.busy && <Loading />}{categories.error !== undefined && <ErrorNotice error={categories.error} retry={categories.reload} />}</>}
      {task && <><div className="file-summary"><strong>{task.fileName}</strong><small>任务 {task.id}</small><small>{bytes(task.sizeBytes)} · 每片 {bytes(task.partSizeBytes)}</small></div>
        <div className="upload-progress"><label htmlFor="upload-progress">已确认分片：{bytes(uploaded)} / {bytes(task.sizeBytes)}</label><progress id="upload-progress" value={uploaded} max={task.sizeBytes} /><div className="progress-label"><span>{Math.floor(uploaded / task.sizeBytes * 100)}%</span><span>{paused && !busy && task.status === "uploading" ? "已暂停，可校验续传" : taskStatus[task.status]}</span></div></div>
        {verifying && <p role="status">{verifying}</p>}
        {task.status === "completed" && task.videoId && <div className="notice" role="status"><strong>{mockEnabled ? "模拟服务端已确认登记" : "服务端已确认登记"}</strong><p>视频可播放状态以元数据处理结果为准。</p><Link className="button" to={`/videos/${encodeURIComponent(task.videoId)}`}>查看视频</Link></div>}
        {task.status === "finalizing" && <div className="notice">等待服务端完成校验；请刷新任务确认结果，勿重复创建。</div>}
      </>}
      {error !== undefined && <ErrorNotice error={error} />}
      <div className="actions"><button disabled={!canUpload} onClick={() => void run()}>{busy ? "正在上传…" : task ? error ? "核对后重试" : "核对并继续上传" : "开始分片上传"}</button>{busy && <button className="secondary" onClick={() => { controller.current?.abort(); setPaused(true); }}>暂停上传</button>}{task && !busy && <button className="secondary" disabled={fetching} onClick={() => void loadTask(task.id)}>刷新服务端任务</button>}{task && !busy && <button className="secondary" onClick={() => { setTask(undefined); setFile(undefined); setTitle(""); setError(undefined); setPaused(false); }}>上传另一个视频</button>}</div>
      {task && task.status !== "completed" && task.uploadedParts.length === Math.ceil(task.sizeBytes / task.partSizeBytes) && <button className="secondary" disabled={busy || fetching} onClick={async () => {
        setFetching(true); setError(undefined);
        try { const result = await completeTask(api, task); update(result.upload); }
        catch (err) { if (alive.current) setError(err); } finally { if (alive.current) setFetching(false); }
      }}>{fetching ? "正在确认…" : "重试服务端完成确认"}</button>}
      {task?.status === "uploading" && !file && <small>请重新选择原文件。系统将核对大小以及每个已完成分片的 SHA-256，文件名相同不能作为续传依据。</small>}
    </section>
    <section className="panel section-space stack"><h2>恢复已有任务</h2><p className="muted">此处仅保存任务提示，不保存视频字节、Cookie、密码或授权信息。读取和续传仍需服务端鉴权。</p>
      {hints.length === 0 ? <small>此浏览器还没有任务提示。</small> : <div className="hint-list">{hints.map(hint => <button className="secondary hint-row" key={hint.id} disabled={busy || fetching} onClick={() => void loadTask(hint.id)}><span>{hint.fileName}<small>{bytes(hint.sizeBytes)} · {date(hint.createdAt)}</small><small>{hint.id}</small></span><span>读取任务</span></button>)}</div>}
      <form className="stack" onSubmit={event => { event.preventDefault(); void loadTask(manualId); }}><label>或输入已知上传任务 ID<input value={manualId} onChange={event => setManualId(event.target.value)} maxLength={256} disabled={busy || fetching} /></label><button className="secondary" type="submit" disabled={busy || fetching || !manualId.trim()}>读取服务端任务</button></form>
    </section>
  </>;
}
