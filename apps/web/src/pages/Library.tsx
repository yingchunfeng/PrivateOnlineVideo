import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { ImportCommitRequest, ImportPreview, Page, VideoDetail, VideoSummary } from "@online-video/shared";
import { api } from "../api";
import { isSiteApiPath } from "../api/client";
import { bytes, duration, Empty, ErrorNotice, Icon, Loading, useLoad, videoStatus } from "../ui";
import { defaultCategory, loadOrganizations, MultiChoice, OrganizationBadges, OrganizationFields } from "../organization";
import type { Organizations } from "../organization";
import { loadLibrary, TagBadges, TagChoice, useLibraryRevision } from "../library";
import { libraryTags, libraryVideoPath, parseTagFilter, publicMediaUrl } from "../library-data";
import { PublicRegisterPanel } from "../public-register";
import "./library-actions.css";

function LibraryVideoCard({ video, categoryName }: { video: VideoSummary; categoryName: string }) {
  const path = `/videos/${encodeURIComponent(video.id)}`;
  return <article className="video-card">
    <Link className="video-card-preview" to={path} aria-label={`播放 ${video.title}`}><Thumbnail video={video} /></Link>
    <div className="card-body">
      <div className="card-meta"><span>{categoryName}</span><span>{duration(video.durationSeconds)}</span></div>
      <h2><Link className="video-card-title-link" to={path}>{video.title}</Link></h2>
      <TagBadges tags={video.tags ?? []} />
      <div className="card-meta"><span className={`state-text ${video.status}`}>{video.publicUrl ? "已登记" : videoStatus[video.status]}</span><span>{bytes(video.sizeBytes)}</span></div>
      <div className="video-card-actions"><Link className="button secondary" to={path}><Icon name="play" />播放</Link><Link className="button secondary" to={`${path}?edit=1`}><Icon name="settings" />编辑</Link></div>
    </div>
  </article>;
}

export function Thumbnail({ video }: { video: VideoSummary }) {
  const [failed, setFailed] = useState(false);
  const timeText = duration(video.durationSeconds);
  let cover: string | undefined;
  try { if (video.coverUrl) cover = publicMediaUrl(video.coverUrl); else if (video.thumbnailUrl && isSiteApiPath(video.thumbnailUrl)) cover = video.thumbnailUrl; } catch { /* 封面地址无效时展示占位，视频仍可播放。 */ }
  useEffect(() => setFailed(false), [cover]);
  return (
    <div className="thumbnail-wrapper">
      {cover && !failed ? (
        <img className="thumbnail" src={cover} alt={`${video.title}的封面`} loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <div className={`thumbnail placeholder ${video.status}`} aria-label="暂无封面">
          <span className="placeholder-art" aria-hidden="true" />
          <Icon name="play" />
          <span>暂无封面</span>
        </div>
      )}
      {timeText !== "时长待采集" && (
        <div className="sci-card-hud-time">
          <span>[{timeText}]</span>
        </div>
      )}
    </div>
  );
}
export function LibraryPage() {
  const libraryRevision = useLibraryRevision();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? ""; const categoryId = params.get("categoryId") ?? "";
  const tagFilter = params.get("tags") ?? ""; const selectedTags = parseTagFilter(tagFilter);
  const page = Math.max(1, Number(params.get("page")) || 1);
  const [draft, setDraft] = useState(q); const [showImport, setShowImport] = useState(false);
  const [showFilterDrawer, setShowFilterDrawer] = useState(() => Boolean(tagFilter));
  useEffect(() => setDraft(q), [q]);
  const list = useLoad(() => {
    return Promise.all([loadLibrary(), api.request<Page<VideoSummary>>(libraryVideoPath(page, q, categoryId, selectedTags))]).then(([library, videos]) => ({ ...library, videos }));
  }, [page, q, categoryId, tagFilter, libraryRevision]);
  const filter = (changes: Record<string, string>) => { const next = new URLSearchParams(params); next.delete("groupIds"); next.delete("tagIds"); for (const [key, value] of Object.entries(changes)) { if (value) next.set(key, value); else next.delete(key); } if (!("page" in changes)) next.delete("page"); setParams(next); };
  const activeFilterCount = selectedTags.length;
  useEffect(() => { if (categoryId && list.data && !list.busy && !list.data.categories.some(category => category.id === categoryId && category.enabled !== false)) filter({ categoryId: "", tags: "" }); }, [categoryId, list.data, list.busy]);

  return <><div className="page-head"><div><div className="eyebrow">YOUR MOMENTS, IN ONE PLACE</div><h1>云影匣·只属于我的光影</h1><p className="muted">把日常与远方，收进自己的云匣。</p></div><Link className="button" to="/upload"><Icon name="upload" />上传视频</Link></div><form className="search-row" onSubmit={event => { event.preventDefault(); filter({ q: draft.trim() }); }}><label className="search-label">搜索标题或标签<input type="search" placeholder="找一个想重温的片刻" value={draft} maxLength={200} onChange={e => setDraft(e.target.value)} /></label><button className="secondary" type="submit">搜索</button></form><div className="category-tabs" aria-label="分类筛选"><button className={categoryId ? "secondary" : "selected"} aria-pressed={!categoryId} onClick={() => filter({ categoryId: "" })}>全部视频</button>{list.data?.categories.filter(category => category.enabled !== false).map(category => <button key={category.id} className={categoryId === category.id ? "selected" : "secondary"} aria-pressed={categoryId === category.id} onClick={() => filter({ categoryId: category.id, tags: "" })}>{category.name}</button>)}<button type="button" className={`filter-trigger-btn ${showFilterDrawer || activeFilterCount > 0 ? "active" : "secondary"}`} aria-expanded={showFilterDrawer} onClick={() => setShowFilterDrawer(v => !v)}><Icon name="filter" /><span>筛选</span>{activeFilterCount > 0 && <span className="filter-count-chip">{activeFilterCount}</span>}</button></div>{list.data && <div className={`filter-drawer ${showFilterDrawer ? "expanded" : "collapsed"}`} aria-hidden={!showFilterDrawer}><div className="filter-drawer-inner"><div className="filter-drawer-header"><div className="filter-drawer-title"><strong>高级筛选</strong><small>按标签过滤视频</small></div>{activeFilterCount > 0 && <button type="button" className="secondary filter-clear-btn" onClick={() => filter({ tags: "" })}>清空已选</button>}</div><div className="stack"><TagChoice items={libraryTags(list.data.categories, categoryId)} selected={selectedTags} onChange={tags => filter({ tags: tags.length ? JSON.stringify(tags) : "" })} filtering /></div></div></div>}<div className="list-bar"><small>{list.data ? `${list.data.videos.total} 个视频` : "私人空间"}{q ? ` · 标题或标签包含“${q}”` : ""}</small><button className="secondary" onClick={() => setShowImport(value => !value)} aria-expanded={showImport}>导入已有视频</button></div>{showImport && list.data && <PublicRegisterPanel library={list.data} onImported={list.reload} />}{list.busy ? <Loading /> : list.error ? <ErrorNotice error={list.error} retry={list.reload} /> : list.data && <>{list.data.videos.items.length === 0 ? <Empty title={q || categoryId || tagFilter ? "没有找到匹配的视频" : "这里还没有视频"}>{q || categoryId || tagFilter ? "试试其他标题、分类或标签。所选标签须全部命中。" : "上传手机视频，或登记已有公开视频。"}</Empty> : <div className="video-grid">{list.data.videos.items.map(video => <LibraryVideoCard key={video.id} video={video} categoryName={list.data?.categories.find(c => c.id === video.categoryId)?.name ?? "未分类"} />)}</div>}<div className="pagination" aria-label="分页"><button className="secondary" disabled={page <= 1} onClick={() => filter({ page: String(page - 1) })}>上一页</button><span>第 {page} / {Math.max(1, Math.ceil(list.data.videos.total / list.data.videos.pageSize))} 页</span><button className="secondary" disabled={page * list.data.videos.pageSize >= list.data.videos.total} onClick={() => filter({ page: String(page + 1) })}>下一页</button></div></>}</>;
}

export function LegacyImportPanel({ organizations, existingVideos, onImported }: { organizations: Organizations; existingVideos: VideoSummary[]; onImported: () => void }) {
  const categories = organizations.categories.filter(c => !c.archivedAt);
  const [category, setCategory] = useState(""); const [groupIds, setGroupIds] = useState<string[]>([]); const [tagIds, setTagIds] = useState<string[]>([]);
  const [preview, setPreview] = useState<ImportPreview>(); const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(); const [message, setMessage] = useState("");
  const [existingVideoId, setExistingVideoId] = useState(""); const existing = existingVideos.find(video => video.id === existingVideoId);
  return <section className="panel stack import-panel"><h2>选择性导入</h2><p className="muted">仅预览服务端已授权目录，并登记勾选的条目。原文件保持不变。</p><form className="stack" onSubmit={async event => { event.preventDefault(); setBusy(true); setError(undefined); setMessage(""); try { setPreview(await api.request<ImportPreview>("/api/imports/preview", { method: "POST", body: { prefix: "" } })); setSelected(new Set()); } catch (err) { setError(err); } finally { setBusy(false); } }}><button type="submit" disabled={busy}>{busy ? "正在预览…" : "预览已有视频"}</button></form>{error !== undefined && <ErrorNotice error={error} />}{message && <div className="notice" role="status">{message}</div>}{preview && <>{preview.items.length === 0 ? <Empty title="授权范围内没有可导入视频" /> : <><div className="import-items">{preview.items.map(item => <label className="check-row" key={item.id}><input type="checkbox" checked={selected.has(item.id)} onChange={e => setSelected(current => { const next = new Set(current); if (e.target.checked) next.add(item.id); else next.delete(item.id); return next; })} disabled={busy} /><span>{item.fileName}<small>{bytes(item.sizeBytes)} · {duration(item.durationSeconds)} · {item.codec ?? "编码待采集"}</small></span></label>)}</div><label>登记方式<select value={existingVideoId} onChange={event => setExistingVideoId(event.target.value)} disabled={busy}><option value="">登记为视频（普通导入）</option>{existingVideos.map(video => <option key={video.id} value={video.id}>确认既有记录位置 · {video.title}</option>)}</select><small>既有记录来自当前视频库页。仅为已明确待绑定的旧记录选取一个对象，服务端核对原 key 与本人归属，不猜测位置。</small></label>{existing ? <div className="notice"><strong>保留既有记录：{existing.title}</strong><p>只确认存储位置，标题、分类、分组、标签与观看记录保持原值。</p><OrganizationBadges organizations={organizations} groupIds={existing.groupIds ?? []} tagIds={existing.tagIds ?? []} /></div> : <OrganizationFields organizations={organizations} category={category} groupIds={groupIds} tagIds={tagIds} onCategory={setCategory} onGroups={setGroupIds} onTags={setTagIds} disabled={busy} categoryLabel="导入到分类" />}<button disabled={busy || selected.size === 0 || categories.length === 0 || !!existing && selected.size !== 1} onClick={async () => {
    setBusy(true); setError(undefined);
    try { const result = await api.request<{ videos: VideoDetail[] }>("/api/imports/commit", { method: "POST", body: { previewId: preview.id, itemIds: [...selected], categoryId: existing?.categoryId ?? (category || defaultCategory(categories)), ...(existing ? { existingVideoId: existing.id } : { groupIds, tagIds }) } satisfies ImportCommitRequest }); setMessage(existing ? "既有记录存储位置已确认；标题、组织与观看记录保留。" : `已登记 ${result.videos.length} 个视频；格式和元数据以服务端结果为准。`); setSelected(new Set()); onImported(); }
    catch (err) { setError(err); } finally { setBusy(false); }
  }}>{busy ? "正在提交…" : existing ? "确认既有记录存储位置" : `导入选中的 ${selected.size} 项`}</button></>}{preview.nextCursor && <button className="secondary" disabled={busy || selected.size > 0} onClick={async () => { setBusy(true); setError(undefined); try { setPreview(await api.request<ImportPreview>("/api/imports/preview", { method: "POST", body: { prefix: "", cursor: preview.nextCursor } })); setSelected(new Set()); } catch (err) { setError(err); } finally { setBusy(false); } }}>下一批视频</button>}{selected.size > 0 && preview.nextCursor && <small>请先导入当前批次所选视频，或取消选择后再翻页。</small>}</>}</section>;
}
