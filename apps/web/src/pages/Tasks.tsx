import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { Page, UploadTask } from "@online-video/shared";
import { api } from "../api";
import { loadLibrary, TagBadges } from "../library";
import { publicMediaUrl } from "../library-data";
import { PublicAddress } from "../public-address";
import { useUploadQueue } from "../upload-context";
import type { LocalTaskState, PreparedVideo } from "../upload-queue";
import { bytes, date, Empty, ErrorNotice, Icon, Loading, useLoad } from "../ui";

const localLabels: Record<LocalTaskState, string> = { prepared: "待提交", creating: "正在创建任务", createFailed: "任务创建失败", queued: "排队等待", uploading: "正在上传", verifying: "正在校验原文件", paused: "本机已暂停", confirming: "字节已传完，正在确认视频登记", savingCover: "视频已登记，正在保存封面", completed: "视频已登记", failed: "执行失败，可核对后重试" };
const serverLabels = { uploading: "待上传 / 可续传", finalizing: "字节已传完，服务端确认中", completed: "视频已登记", failed: "服务端失败，可重试" };
export function TasksPage() {
  const { entries, queue } = useUploadQueue(); const [page, setPage] = useState(1); const [status, setStatus] = useState("");
  const history = useLoad(() => { const query = new URLSearchParams({ page: String(page), pageSize: "20" }); if (status) query.set("status", status); return api.request<Page<UploadTask>>(`/api/uploads?${query}`); }, [page, status]);
  const library = useLoad(loadLibrary);
  const localOnly = entries.filter(entry => !!entry.createRequest && !entry.task);
  const active = entries.some(entry => ["queued", "creating", "uploading", "verifying", "confirming", "savingCover"].includes(entry.state));
  useEffect(() => { if (!active) { history.reload(); return; } const timer = setInterval(history.reload, 2500); return () => clearInterval(timer); }, [active]);
  const visibleIds = new Set(history.data?.items.map(task => task.id));
  const pending = entries.filter(entry => entry.task && !visibleIds.has(entry.task.id) && (!status || entry.task.status === status) && entry.state !== "completed");
  return <>
    <div className="page-head"><div><div className="eyebrow">TRANSFER CONTROL & HISTORY</div><h1>任务列表</h1><p className="muted">进度、开始、暂停、续传、重试和完成结果集中在这里。切换页面继续逐个上传。</p></div><Link className="button" to="/upload"><Icon name="upload" />准备视频</Link></div>
    <div className="notice compact-notice">历史任务从服务器分页读取。刷新后浏览器无法找回本地 File，请重新选择原文件；不会仅凭文件名续传。</div>
    <div className="list-bar task-list-controls"><label>任务状态<select aria-label="任务状态筛选" value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}>{[["", "全部任务"], ["uploading", "待上传 / 上传中"], ["finalizing", "确认中"], ["completed", "已完成"], ["failed", "失败"]].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button className="secondary" onClick={history.reload}>刷新任务历史</button></div>
    {localOnly.length > 0 && <section className="stack section-space"><h2>任务创建与恢复</h2>{localOnly.map(entry => <article className="panel stack upload-task-card" key={entry.clientId} data-client-id={entry.clientId}><h3>{entry.title}</h3><small>{entry.fileName} · {bytes(entry.sizeBytes)} · {localLabels[entry.state]}</small>{entry.error !== undefined && <ErrorNotice error={entry.error} />}<button className="secondary" disabled={entry.state !== "createFailed"} onClick={() => queue.retry(entry.clientId)}>重试创建此任务</button><small>使用原 clientRequestId 和原提交内容，成功项不会重复创建。</small></article>)}</section>}
    {pending.length > 0 && <section className="stack section-space" aria-label="本机执行队列"><h2>本机执行队列</h2>{pending.map(entry => <TaskCard key={entry.clientId} task={entry.task!} entry={entry} onUpdated={history.reload} categoryName={library.data?.categories.find(category => category.id === entry.categoryId)?.name} />)}</section>}
    {history.error !== undefined && <ErrorNotice error={history.error} retry={history.reload} />}
    {!history.data && history.busy ? <Loading /> : history.data && <section className="stack section-space" aria-label="服务端任务历史"><div className="list-bar"><h2>服务端任务历史</h2><small>{history.data.total} 个任务{active ? " · 本机正在逐个执行" : ""}</small></div>{history.data.items.length ? history.data.items.map(task => <TaskCard key={task.id} task={task} entry={entries.find(entry => entry.task?.id === task.id)} categoryName={library.data?.categories.find(category => category.id === task.categoryId)?.name} onUpdated={history.reload} />) : <Empty title="暂无匹配任务">在上传页选择视频后提交，即可创建独立任务。</Empty>}<div className="pagination" aria-label="任务分页"><button className="secondary" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>上一页</button><span>第 {page} / {Math.max(1, Math.ceil(history.data.total / history.data.pageSize))} 页</span><button className="secondary" disabled={page * history.data.pageSize >= history.data.total} onClick={() => setPage(value => value + 1)}>下一页</button></div></section>}
  </>;
}
function TaskCard({ task: initial, entry, categoryName, onUpdated }: { task: UploadTask; entry?: PreparedVideo | undefined; categoryName?: string | undefined; onUpdated: () => void }) {
  const { queue } = useUploadQueue(); const task = entry?.task ?? initial; const [error, setError] = useState<unknown>(); const [attaching, setAttaching] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const uploaded = task.uploadedParts.reduce((sum, part) => sum + part.sizeBytes, 0); const full = task.uploadedParts.length === Math.ceil(task.sizeBytes / task.partSizeBytes);
  const working = !!entry && ["uploading", "verifying", "confirming", "savingCover"].includes(entry.state);
  const completed = task.status === "completed";
  const coverUrl = entry?.video?.coverUrl ?? task.coverUrl; let imageUrl: string | undefined;
  try { if (coverUrl) imageUrl = publicMediaUrl(coverUrl); } catch { /* 无效公开地址只展示占位。 */ }
  useEffect(() => setImageFailed(false), [imageUrl, entry?.cover?.url]);
  const publicUrl = entry?.video?.publicUrl ?? task.publicUrl;
  const coverSaved = entry?.video?.coverStatus === "saved" || task.coverStatus === "saved";
  return <article className="panel stack upload-task-card" data-task-id={task.id}>
    <div className="task-card-head">{!imageFailed && (imageUrl || entry?.cover?.url) ? <img className="task-cover-image" src={imageUrl ?? entry?.cover?.url} alt={`${entry?.title ?? task.title ?? task.fileName}的封面`} onError={() => setImageFailed(true)} /> : <div className="task-cover-image placeholder"><Icon name="play" /><small>暂无封面</small></div>}<div><h3>{entry?.title ?? task.title ?? task.fileName}</h3><small>{task.fileName} · {bytes(task.sizeBytes)} · {categoryName ?? "历史分类"}</small><TagBadges tags={entry?.tags ?? task.tags ?? []} /><small>{date(task.createdAt)}</small></div></div>
    <div className="progress-info-row"><strong role="status">{entry ? localLabels[entry.state] : serverLabels[task.status]}</strong><span>{Math.min(100, Math.floor(uploaded / task.sizeBytes * 100))}%</span></div><div className="neon-progress-bar"><div className="neon-progress-fill" style={{ width: `${Math.min(100, uploaded / task.sizeBytes * 100)}%` }} /></div><small>{bytes(uploaded)} / {bytes(task.sizeBytes)} 已确认字节{full && !completed ? "；尚未确认视频登记" : ""}</small>
    {entry?.notice && <small role="status">{entry.notice}</small>}
    {completed && <div className={`notice ${coverSaved ? "completed-sci-notice" : "warning"}`} role="status"><strong>{coverSaved ? "视频已登记，封面已保存" : "视频已登记，封面待补"}</strong><p>{coverSaved ? "视频和封面均已由后端确认。" : "视频可直接播放，封面失败或未采集不会阻断播放。"}</p>{task.videoId && <Link className="button" to={`/videos/${encodeURIComponent(task.videoId)}`}>播放视频</Link>}{publicUrl && <PublicAddress publicUrl={publicUrl} />}</div>}
    {entry?.error !== undefined && <ErrorNotice error={entry.error} />}{error !== undefined && <ErrorNotice error={error} />}{task.errorCode && !entry?.error && <small className="state-text failed">服务端错误：{task.errorCode}</small>}
    <div className="sci-actions-group">{!completed && <>{working ? <button className="secondary" onClick={() => entry && queue.pause(entry.clientId)}>暂停上传</button> : entry?.state === "queued" ? <button className="secondary" onClick={() => queue.pause(entry.clientId)}>暂停排队</button> : (entry?.file || full) ? <button className="button" disabled={attaching} onClick={() => { if (entry) queue.retry(entry.clientId); else queue.recover(task); }}>{full ? "重试完成确认" : entry?.state === "failed" ? "核对后重试" : "开始 / 继续上传"}</button> : null}</>}
      {completed && !coverSaved && entry?.cover && <button className="secondary" disabled={working} onClick={() => entry && void queue.retryCover(entry.clientId)}>单独重试保存封面</button>}
      {(!completed || !coverSaved) && !working && <label className="button secondary task-file-selector">{attaching ? "正在校验原文件…" : completed ? "重新选择原文件补封面" : "重新选择原文件继续"}<input type="file" aria-label={`原文件 ${task.fileName}`} accept="video/*,.mp4,.mov,.webm,.mkv,.m4v" disabled={attaching} onChange={async event => { const file = event.target.files?.[0]; event.target.value = ""; if (!file) return; setAttaching(true); setError(undefined); try { await queue.attach(task, file); onUpdated(); } catch (err) { setError(err); } finally { setAttaching(false); } }} /></label>}
    </div>{!completed && !entry?.file && !full && <small>大小必须相同，并逐片比对服务端已确认分片的 SHA-256；零已确认分片时无法比对原文件已有摘要。</small>}
  </article>;
}
