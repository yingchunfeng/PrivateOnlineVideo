import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { UpdateVideoRequest, VideoDetail } from "@online-video/shared";
import { api } from "../api";
import { bytes, date, duration, videoDuration, ErrorNotice, Icon, Loading, useLoad } from "../ui";
import { OrganizationFields, sameSelection } from "../organization";
import type { Organizations } from "../organization";
import { loadLibrary, notifyLibraryChanged, TagBadges, useLibraryRevision } from "../library";
import { PublicVideoPlayer } from "../public-player";
import { PublicAddress } from "../public-address";
import "./video-editor.css";
import { VideoEditorDialog } from "../video-editor";
import { useAuth } from "../auth";

export function VideoPage() {
  const auth = useAuth(); const canManage = auth.can("video_edit") || auth.can("video_delete");
  const { videoId = "" } = useParams();
  const navigate = useNavigate(); const playerContainer = useRef<HTMLDivElement>(null);
  const [removed, setRemoved] = useState(false); const [savedDuration, setSavedDuration] = useState<{ id: string; seconds: number }>();
  useEffect(() => { setRemoved(false); setSavedDuration(undefined); }, [videoId]);
  const [params, setParams] = useSearchParams();
  const libraryRevision = useLibraryRevision();
  const detail = useLoad(() => Promise.all([api.request<VideoDetail>(`/api/videos/${encodeURIComponent(videoId)}`), loadLibrary()]).then(([video, library]) => ({ video, ...library })), [videoId, libraryRevision]);
  const editing = params.get("edit") === "1";
  const setEditing = (value: boolean) => {
    const next = new URLSearchParams(params);
    if (value) next.set("edit", "1"); else next.delete("edit");
    setParams(next, { replace: true });
  };
  // 已有数据时不得因重新加载卸载页面：窗口重新聚焦（例如关掉系统文件选择框）会触发
  // libraryRevision 刷新，整页卸载会连带卸载编辑弹窗，刚选好的封面文件与表单输入全部丢失。
  if (!detail.data && detail.busy) return <Loading />;
  if (!detail.data && detail.error) return <ErrorNotice error={detail.error} retry={detail.reload} />;
  if (!detail.data) return null;
  const { video, categories } = detail.data;
  const editor = editing && canManage && <VideoEditorDialog videoId={video.id} library={detail.data} onClose={() => { if (removed) navigate("/", { replace: true }); else setEditing(false); }} onSaved={() => { setEditing(false); notifyLibraryChanged(); detail.reload(); }} onDeleted={() => setRemoved(true)} />;
  // 编辑器必须始终占据树中同一位置：删除成功后 removed 翻转，如果改变返回结构会导致
  // VideoEditorDialog 被卸载重挂、"记录已删除"结果弹窗状态丢失并触发一次必然 404 的详情请求。
  return (
    <>
      {editor}
      {removed ? null : <>
        <div className="video-page-topbar">
          <Link className="back-nav-btn" to="/">
            <Icon name="chevron" />
            <span>返回</span>
          </Link>
          <span className="header-divider">|</span>
          <h1 className="video-header-title">{video.title}</h1>
          <div className="video-topbar-actions">
            {canManage && <button className="secondary" onClick={() => { playerContainer.current?.querySelector("video")?.pause(); setEditing(true); }} aria-haspopup="dialog">
              {auth.can("video_edit") ? "编辑信息" : "管理记录"}
            </button>}
          </div>
        </div>

        <div className="video-player-container" ref={playerContainer}>
          <PublicVideoPlayer key={video.id} video={video} library={detail.data} canSaveDuration={auth.can("video_edit")} onDurationSaved={saved => setSavedDuration({ id: saved.id, seconds: saved.durationSeconds! })} />
        </div>

        {/* 科技控制条：标题、标签与操作按钮（参考设计图第2幅） */}
        <div className="video-detail-bar">
          <div className="video-detail-left">
            <div className="video-main-title-row">
              <h2>{video.title}</h2>
              <span className={`state-badge ${video.status}`}>已登记</span>
            </div>
            <div className="video-tags-row">
              <span className="category-pill-badge">
                {categories.find(c => c.id === video.categoryId)?.name ?? "未分类"}
              </span>
              <TagBadges tags={video.tags ?? []} />
            </div>
          </div>
          <div className="video-detail-right">
            <PublicAddress publicUrl={video.publicUrl} library={detail.data} />
          </div>
        </div>

        {/* 科技数据面板 (DATA PANEL - 参考设计图第2幅底层) */}
        <section className="sci-data-panel">
          <div className="sci-data-panel-header">
            <div className="sci-data-title">
              <span className="cyber-glow-bar" />
              <strong>数据面板</strong>
              <small>DATA PANEL</small>
            </div>
            <span className="sci-sys-info">视频文件信息</span>
          </div>

          <div className="sci-data-grid">
            <div className="sci-data-cell">
              <span className="sci-data-label">分辨率</span>
              <span className="sci-data-value">
                {video.width !== null && video.height !== null ? `${video.width} × ${video.height}` : "尚未采集"}
              </span>
            </div>
            <div className="sci-data-cell">
              <span className="sci-data-label">编码</span>
              <span className="sci-data-value highlight">
                {video.codec ? video.codec.toUpperCase() : "尚未采集"}
              </span>
            </div>
            <div className="sci-data-cell">
              <span className="sci-data-label">时长</span>
              <span className="sci-data-value code">
                {videoDuration(savedDuration?.id === video.id ? savedDuration.seconds : video.durationSeconds)}
              </span>
            </div>
            <div className="sci-data-cell">
              <span className="sci-data-label">文件大小</span>
              <span className="sci-data-value">
                {bytes(video.sizeBytes)}
              </span>
            </div>
            <div className="sci-data-cell">
              <span className="sci-data-label">上传日期</span>
              <span className="sci-data-value">
                {date(video.createdAt)}
              </span>
            </div>
            <div className="sci-data-cell">
              <span className="sci-data-label">观看位置</span>
              <span className="sci-data-value accent">
                {duration(video.lastPositionSeconds)}
              </span>
            </div>
          </div>
        </section>
      </>}
    </>
  );
}
export function LegacyVideoEditor({ video, organizations, onSaved }: { video: VideoDetail; organizations: Organizations; onSaved: () => void }) {
  const [title, setTitle] = useState(video.title); const [category, setCategory] = useState(video.categoryId); const [groupIds, setGroupIds] = useState(video.groupIds ?? []); const [tagIds, setTagIds] = useState(video.tagIds ?? []); const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>();
  useEffect(() => { setTitle(video.title); setCategory(video.categoryId); setGroupIds(video.groupIds ?? []); setTagIds(video.tagIds ?? []); }, [video]);
  return <form className="panel stack section-space" onSubmit={async event => { event.preventDefault(); setBusy(true); setError(undefined); try { await api.request<VideoDetail>(`/api/videos/${encodeURIComponent(video.id)}`, { method: "PATCH", body: { title: title.trim(), ...(category !== video.categoryId ? { categoryId: category } : {}), ...(!sameSelection(groupIds, video.groupIds ?? []) ? { groupIds } : {}), ...(!sameSelection(tagIds, video.tagIds ?? []) ? { tagIds } : {}) } satisfies UpdateVideoRequest }); onSaved(); } catch (err) { setError(err); } finally { setBusy(false); } }}><h2>修改标题与组织信息</h2><label>视频标题<input value={title} onChange={e => setTitle(e.target.value)} maxLength={200} required disabled={busy} /></label><OrganizationFields organizations={organizations} category={category} groupIds={groupIds} tagIds={tagIds} onCategory={setCategory} onGroups={setGroupIds} onTags={setTagIds} disabled={busy} /><small>取消选择只解除关联，原视频保留。已归档关联可继续查看；修改同一维度前请取消归档项或恢复组织项。</small>{error !== undefined && <ErrorNotice error={error} />}<button disabled={busy || !title.trim()} type="submit">{busy ? "正在保存…" : "保存视频信息"}</button></form>;
}
