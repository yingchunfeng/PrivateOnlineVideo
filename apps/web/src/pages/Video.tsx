import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { UpdateVideoRequest, VideoDetail } from "@online-video/shared";
import { api } from "../api";
import { bytes, date, duration, ErrorNotice, Icon, Loading, useLoad, videoStatus } from "../ui";
import { VideoPlayer } from "../player";
import { loadOrganizations, OrganizationBadges, OrganizationFields, sameSelection } from "../organization";
import type { Organizations } from "../organization";
import { OriginalDownload } from "../download";
import { loadLibrary, notifyLibraryChanged, TagBadges, TagChoice, useLibraryRevision } from "../library";
import { libraryTags } from "../library-data";
import { PublicVideoPlayer } from "../public-player";
import { PublicAddress } from "../public-address";
import type { LibraryConfig } from "@online-video/shared";
import { useFeedback } from "../feedback";
import "./video-editor.css";

export function VideoPage() {
  const { videoId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const libraryRevision = useLibraryRevision();
  const detail = useLoad(() => Promise.all([api.request<VideoDetail>(`/api/videos/${encodeURIComponent(videoId)}`), loadLibrary()]).then(([video, library]) => ({ video, ...library })), [videoId, libraryRevision]);
  const editing = params.get("edit") === "1";
  const setEditing = (value: boolean) => {
    const next = new URLSearchParams(params);
    if (value) next.set("edit", "1"); else next.delete("edit");
    setParams(next, { replace: true });
  };
  if (detail.busy) return <Loading />;
  if (detail.error) return <ErrorNotice error={detail.error} retry={detail.reload} />;
  if (!detail.data) return null;
  const { video, categories } = detail.data;
  return (
    <>
      <div className="video-page-topbar">
        <Link className="back-nav-btn" to="/">
          <Icon name="chevron" />
          <span>返回</span>
        </Link>
        <span className="header-divider">|</span>
        <h1 className="video-header-title">{video.title}</h1>
        <div className="video-topbar-actions">
          <button className="secondary" onClick={() => setEditing(!editing)} aria-expanded={editing} aria-controls="video-editor">
            {editing ? "收起编辑" : "编辑信息"}
          </button>
        </div>
      </div>

      {editing && (
        <VideoEditor
          video={video}
          library={detail.data}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            notifyLibraryChanged();
            detail.reload();
          }}
        />
      )}

      <div className="video-player-container">
        <PublicVideoPlayer key={video.id} video={video} />
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
          <PublicAddress publicUrl={video.publicUrl} />
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
          <span className="sci-sys-info">SYS_INFO v2.0.8</span>
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
              {duration(video.durationSeconds)}
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
    </>
  );
}
export function LegacyVideoEditor({ video, organizations, onSaved }: { video: VideoDetail; organizations: Organizations; onSaved: () => void }) {
  const [title, setTitle] = useState(video.title); const [category, setCategory] = useState(video.categoryId); const [groupIds, setGroupIds] = useState(video.groupIds ?? []); const [tagIds, setTagIds] = useState(video.tagIds ?? []); const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>();
  useEffect(() => { setTitle(video.title); setCategory(video.categoryId); setGroupIds(video.groupIds ?? []); setTagIds(video.tagIds ?? []); }, [video]);
  return <form className="panel stack section-space" onSubmit={async event => { event.preventDefault(); setBusy(true); setError(undefined); try { await api.request<VideoDetail>(`/api/videos/${encodeURIComponent(video.id)}`, { method: "PATCH", body: { title: title.trim(), ...(category !== video.categoryId ? { categoryId: category } : {}), ...(!sameSelection(groupIds, video.groupIds ?? []) ? { groupIds } : {}), ...(!sameSelection(tagIds, video.tagIds ?? []) ? { tagIds } : {}) } satisfies UpdateVideoRequest }); onSaved(); } catch (err) { setError(err); } finally { setBusy(false); } }}><h2>修改标题与组织信息</h2><label>视频标题<input value={title} onChange={e => setTitle(e.target.value)} maxLength={200} required disabled={busy} /></label><OrganizationFields organizations={organizations} category={category} groupIds={groupIds} tagIds={tagIds} onCategory={setCategory} onGroups={setGroupIds} onTags={setTagIds} disabled={busy} /><small>取消选择只解除关联，原视频保留。已归档关联可继续查看；修改同一维度前请取消归档项或恢复组织项。</small>{error !== undefined && <ErrorNotice error={error} />}<button disabled={busy || !title.trim()} type="submit">{busy ? "正在保存…" : "保存视频信息"}</button></form>;
}

function VideoEditor({ video, library, onSaved, onCancel }: { video: VideoDetail; library: LibraryConfig; onSaved: () => void; onCancel: () => void }) {
  const [title, setTitle] = useState(video.title);
  const [category, setCategory] = useState(video.categoryId);
  const [tags, setTags] = useState(video.tags ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const { toast, toastError } = useFeedback();
  useEffect(() => { setTitle(video.title); setCategory(video.categoryId); setTags(video.tags ?? []); setError(undefined); }, [video]);
  const selectedCategory = library.categories.find(item => item.id === category);
  const availableTags = selectedCategory && selectedCategory.enabled !== false ? libraryTags(library.categories, category) : [];
  return (
    <form id="video-editor" className="panel stack video-editor" aria-labelledby="video-editor-title" aria-busy={busy} onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError(undefined);
      try {
        await api.request<VideoDetail>(`/api/videos/${encodeURIComponent(video.id)}`, { method: "PATCH", body: {
          title: title.trim(),
          ...(category !== video.categoryId ? { categoryId: category, tags } : !sameSelection(tags, video.tags ?? []) ? { tags } : {})
        } satisfies UpdateVideoRequest });
        toast("视频信息已保存"); onSaved();
      } catch (err) { setError(err); toastError(err); }
      finally { setBusy(false); }
    }}>
      <div className="video-editor-heading"><h2 id="video-editor-title">编辑视频信息</h2><small>修改分类和标签后即可在视频库筛选。</small></div>
      <div className="video-editor-fields">
        <label>视频标题<input value={title} onChange={event => setTitle(event.target.value)} maxLength={200} required disabled={busy} autoFocus /></label>
        <label>视频分类<select aria-label="视频分类" value={category} disabled={busy} required onChange={event => {
          const nextCategory = event.target.value;
          const validTags = libraryTags(library.categories, nextCategory);
          setCategory(nextCategory); setTags(current => current.filter(tag => validTags.includes(tag))); setError(undefined);
        }}>
          {!library.categories.some(item => item.id === video.categoryId) && <option value={video.categoryId}>当前分类（历史记录）</option>}
          {library.categories.map(item => <option key={item.id} value={item.id} disabled={item.enabled === false}>{item.name}{item.enabled === false ? "（已停用）" : ""}</option>)}
        </select></label>
      </div>
      <TagChoice items={availableTags} selected={tags} onChange={setTags} disabled={busy} />
      <small>切换分类时仅保留该分类可用的标签；当前历史标签可保留或取消。</small>
      {error !== undefined && <ErrorNotice error={error} />}
      <div className="video-editor-actions"><button disabled={busy || !title.trim() || !category} type="submit">{busy ? "正在保存…" : "保存视频信息"}</button><button className="secondary" type="button" disabled={busy} onClick={onCancel}>取消</button></div>
    </form>
  );
}
