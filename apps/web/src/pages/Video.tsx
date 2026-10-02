import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { Category, VideoDetail } from "@online-video/shared";
import { api } from "../api";
import { bytes, date, duration, ErrorNotice, Loading, useLoad, videoStatus } from "../ui";
import { VideoPlayer } from "../player";

export function VideoPage() {
  const { videoId = "" } = useParams();
  const detail = useLoad(() => Promise.all([api.request<VideoDetail>(`/api/videos/${encodeURIComponent(videoId)}`), api.request<Category[]>("/api/categories")]).then(([video, categories]) => ({ video, categories })), [videoId]);
  const [editing, setEditing] = useState(false);
  if (detail.busy) return <Loading />;
  if (detail.error) return <ErrorNotice error={detail.error} retry={detail.reload} />;
  if (!detail.data) return null;
  const { video, categories } = detail.data;
  return <><Link className="text-link" to="/">← 返回视频库</Link><div className="page-head"><div><h1>{video.title}</h1><p className="muted">{categories.find(c => c.id === video.categoryId)?.name ?? "分类待确认"} · {videoStatus[video.status]}</p></div><button className="secondary" onClick={() => setEditing(value => !value)} aria-expanded={editing}>编辑信息</button></div>{editing && <VideoEditor video={video} categories={categories} onSaved={() => { setEditing(false); detail.reload(); }} />}{video.playable && video.status === "ready" ? <VideoPlayer key={video.id} video={video} /> : <div className="notice">{video.status === "unsupported" ? "此原片格式暂不支持网页播放。保留原片，可离线生成 MP4/H.264/AAC 兼容副本后另行导入；网站不会自动压缩或覆盖原片。" : video.status === "failed" ? "视频处理失败，请由后端检查元数据与存储状态。原片不会自动删除。" : "视频正在处理，元数据确认后更新可播放状态。"}</div>}<section className="panel"><h2>视频信息</h2><dl className="metadata"><div><dt>时长</dt><dd>{duration(video.durationSeconds)}</dd></div><div><dt>原文件大小</dt><dd>{bytes(video.sizeBytes)}</dd></div><div><dt>编码</dt><dd>{video.codec ?? "尚未采集"}</dd></div><div><dt>分辨率</dt><dd>{video.width !== null && video.height !== null ? `${video.width} × ${video.height}` : "尚未采集"}</dd></div><div><dt>登记时间</dt><dd>{date(video.createdAt)}</dd></div><div><dt>观看位置</dt><dd>{duration(video.lastPositionSeconds)}</dd></div></dl></section></>;
}
function VideoEditor({ video, categories, onSaved }: { video: VideoDetail; categories: Category[]; onSaved: () => void }) {
  const [title, setTitle] = useState(video.title); const [category, setCategory] = useState(video.categoryId); const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>();
  useEffect(() => { setTitle(video.title); setCategory(video.categoryId); }, [video]);
  return <form className="panel stack section-space" onSubmit={async event => { event.preventDefault(); setBusy(true); setError(undefined); try { await api.request<VideoDetail>(`/api/videos/${encodeURIComponent(video.id)}`, { method: "PATCH", body: { title: title.trim(), categoryId: category } }); onSaved(); } catch (err) { setError(err); } finally { setBusy(false); } }}><h2>修改标题与分类</h2><label>视频标题<input value={title} onChange={e => setTitle(e.target.value)} maxLength={200} required disabled={busy} /></label><label>视频分类<select value={category} onChange={e => setCategory(e.target.value)} disabled={busy}>{categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>{error !== undefined && <ErrorNotice error={error} />}<button disabled={busy || !title.trim()} type="submit">{busy ? "正在保存…" : "保存视频信息"}</button></form>;
}
