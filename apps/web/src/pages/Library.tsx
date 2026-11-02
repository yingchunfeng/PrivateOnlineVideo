import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { ImportCommitRequest, ImportPreview, Page, VideoDetail, VideoSummary } from "@online-video/shared";
import { api } from "../api";
import { isSiteApiPath } from "../api/client";
import { bytes, duration, videoDuration, Empty, ErrorNotice, Icon, Loading, useLoad } from "../ui";
import { defaultCategory, loadOrganizations, MultiChoice, OrganizationBadges, OrganizationFields } from "../organization";
import type { Organizations } from "../organization";
import { loadLibrary, TagBadges, TagChoice, useLibraryRevision } from "../library";
import { libraryTags, libraryVideoPath, parseTagFilter, publicMediaUrl } from "../library-data";
import type { PublicMediaPolicy } from "../library-data";
import "./library-actions.css";
import { OrbitIllustration } from "../space-console";
import { VIDEO_DURATION_SAVED } from "../media-duration";

function LibraryVideoCard({ video, categoryName, library }: { video: VideoSummary; categoryName: string; library: PublicMediaPolicy | undefined }) {
  const path = `/videos/${encodeURIComponent(video.id)}`;
  return <article className="video-card">
    <Link className="video-card-preview" to={path} aria-label={`播放 ${video.title}`}><Thumbnail video={video} library={library} /></Link>
    <div className="card-body">
      <div className="card-meta"><span>{categoryName}</span><span>{videoDuration(video.durationSeconds)}</span></div>
      <h2 className="library-card-title"><Link className="video-card-title-link" to={path} title={video.title}>{video.title}</Link></h2>
      <div className="library-card-tags"><TagBadges tags={video.tags?.slice(0, 2) ?? []} />{video.tags && video.tags.length > 2 && <span className="library-tag-overflow" title={video.tags.join("、")} aria-label={`另有 ${video.tags.length - 2} 个标签`}>+{video.tags.length - 2}</span>}</div>
      <div className="card-meta library-card-size"><span>{bytes(video.sizeBytes)}</span></div>
    </div>
  </article>;
}

export function Thumbnail({ video, library }: { video: VideoSummary; library?: PublicMediaPolicy | undefined }) {
  const [failed, setFailed] = useState(false);
  const timeText = videoDuration(video.durationSeconds);
  let cover: string | undefined;
  try { if (video.coverUrl) cover = publicMediaUrl(video.coverUrl, library); else if (video.thumbnailUrl && isSiteApiPath(video.thumbnailUrl)) cover = video.thumbnailUrl; } catch { /* 封面地址无效时展示占位，视频仍可播放。 */ }
  useEffect(() => setFailed(false), [cover]);
  return (
    <div className="thumbnail-wrapper">
      {cover && !failed ? (
        <img className="thumbnail" src={cover} alt={`${video.title}的封面`} loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <div className={`thumbnail placeholder ${video.status}`} aria-label="暂无封面">
          <span className="placeholder-art" aria-hidden="true" />
          <OrbitIllustration />
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
// 视频列表无限滚动：维护已加载的视频累积列表，滚动接近底部时追加下一页。
// 通过在列表末尾追加（而非整体替换）并保持稳定 key，列表位置不会跳变。
function useInfiniteVideos(q: string, categoryId: string, tags: string, revision: number) {
  const [items, setItems] = useState<VideoSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(12);
  const [page, setPage] = useState(1);
  const [initialBusy, setInitialBusy] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>();
  const [moreError, setMoreError] = useState<unknown>();
  const [reloadVersion, setReloadVersion] = useState(0);
  const loadingRef = useRef(false);
  // 代际标记：筛选条件变化（含首次加载/刷新）时自增，用于丢弃过期的追加请求。
  const generationRef = useRef(0);
  // 首次加载或筛选条件（含 revision）变化时，重置并加载第一页。
  useEffect(() => {
    let alive = true;
    const generation = ++generationRef.current;
    loadingRef.current = true;
    setInitialBusy(true); setError(undefined); setMoreError(undefined); setItems([]); setTotal(0); setPage(1);
    api.request<Page<VideoSummary>>(libraryVideoPath(1, q, categoryId, parseTagFilter(tags)))
      .then(data => { if (!alive || generationRef.current !== generation) return; setItems(data.items); setTotal(data.total); setPageSize(data.pageSize); setPage(1); })
      .catch(err => { if (alive) setError(err); })
      .finally(() => { if (alive) { loadingRef.current = false; setInitialBusy(false); } });
    return () => { alive = false; };
  }, [q, categoryId, tags, revision, reloadVersion]);
  // 追加下一页：仅由底部哨兵接近视口时调用，保留已有列表。
  const loadMore = useCallback(() => {
    if (loadingRef.current || initialBusy || error) return;
    if (items.length >= total) return;
    const nextPage = page + 1;
    const generation = generationRef.current;
    loadingRef.current = true;
    setMoreError(undefined);
    setLoadingMore(true);
    api.request<Page<VideoSummary>>(libraryVideoPath(nextPage, q, categoryId, parseTagFilter(tags)))
      .then(data => { if (generationRef.current !== generation) return; setItems(prev => [...prev, ...data.items]); setTotal(data.total); setPage(nextPage); })
      .catch(err => setMoreError(err))
      .finally(() => { loadingRef.current = false; setLoadingMore(false); });
  }, [page, items.length, total, initialBusy, error, q, categoryId, tags]);
  const reload = useCallback(() => { setMoreError(undefined); setReloadVersion(v => v + 1); }, []);
  return { items, total, pageSize, initialBusy, loadingMore, error, moreError, hasMore: items.length < total, loadMore, reload };
}

export function LibraryPage() {
  const libraryRevision = useLibraryRevision();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? ""; const categoryId = params.get("categoryId") ?? "";
  const tagFilter = params.get("tags") ?? ""; const selectedTags = parseTagFilter(tagFilter);
  const [draft, setDraft] = useState(q); const [showSearch, setShowSearch] = useState(false);
  const [showFilterDrawer, setShowFilterDrawer] = useState(false); const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => setDraft(q), [q]);
  useEffect(() => { if (showSearch) searchInput.current?.focus(); }, [showSearch]);
  // 库配置（分类/标签）单独加载，仅在 revision 变化时刷新，避免每次翻页重复请求。
  const library = useLoad(() => loadLibrary(), [libraryRevision]);
  // 视频列表改为无限滚动：滚动接近底部时自动追加下一页。
  const videos = useInfiniteVideos(q, categoryId, tagFilter, libraryRevision);
  useEffect(() => { const saved = () => videos.reload(); window.addEventListener(VIDEO_DURATION_SAVED, saved); return () => window.removeEventListener(VIDEO_DURATION_SAVED, saved); }, []);
  const filter = (changes: Record<string, string>) => { const next = new URLSearchParams(params); next.delete("groupIds"); next.delete("tagIds"); next.delete("page"); for (const [key, value] of Object.entries(changes)) { if (value) next.set(key, value); else next.delete(key); } setParams(next); };
  const activeFilterCount = selectedTags.length;
  useEffect(() => { if (categoryId && library.data && !library.busy && !library.data.categories.some(category => category.id === categoryId && category.enabled !== false)) filter({ categoryId: "", tags: "" }); }, [categoryId, library.data, library.busy]);
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) videos.loadMore(); }, { rootMargin: "400px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [videos.loadMore]);

  return <div className="library-page">
    <div className="page-head station-heading"><div><h1>云影匣·属于我的光影</h1><p className="muted">把日常与远方，收进自己的云匣。</p></div></div>
    <div className="library-toolbar"><div className="category-tabs" aria-label="分类筛选"><button className={categoryId ? "secondary" : "selected"} aria-pressed={!categoryId} onClick={() => filter({ categoryId: "" })}>全部视频</button>{library.data?.categories.filter(category => category.enabled !== false).map(category => <button key={category.id} className={categoryId === category.id ? "selected" : "secondary"} aria-pressed={categoryId === category.id} onClick={() => filter({ categoryId: category.id, tags: "" })}>{category.name}</button>)}</div><div className="library-toolbar-actions">
      <button type="button" className={`secondary library-icon-trigger ${showSearch || q ? "active" : ""}`} aria-label="搜索" title={q ? `搜索：${q}` : "搜索"} aria-expanded={showSearch} aria-controls="library-search" aria-pressed={!!q} onClick={() => setShowSearch(value => !value)}><Icon name="search" />{q && <span className="library-condition-dot" />}</button>
      <button type="button" className={`secondary library-icon-trigger ${showFilterDrawer || activeFilterCount ? "active" : ""}`} aria-label="筛选" title={activeFilterCount ? `筛选：已选 ${activeFilterCount} 个标签` : "筛选"} aria-expanded={showFilterDrawer} aria-controls="library-filter" aria-pressed={activeFilterCount > 0} onClick={() => setShowFilterDrawer(value => !value)}><Icon name="filter" />{activeFilterCount > 0 && <span className="library-filter-count">{activeFilterCount}</span>}</button>
    </div></div>
    {showSearch && <form id="library-search" className="search-row library-search-panel" onSubmit={event => { event.preventDefault(); filter({ q: draft.trim() }); }}><label className="search-label">搜索标题或标签<input ref={searchInput} type="search" placeholder="找一个想重温的片刻" value={draft} maxLength={200} onChange={event => setDraft(event.target.value)} /></label><button className="secondary" type="submit">应用搜索</button>{(q || draft) && <button className="secondary" type="button" onClick={() => { setDraft(""); filter({ q: "" }); }}>清空搜索</button>}</form>}
    {showFilterDrawer && library.data && <section id="library-filter" className="library-filter-panel"><div className="filter-drawer-header"><div className="filter-drawer-title"><strong>标签筛选</strong><small>需同时命中所选项</small></div>{activeFilterCount > 0 && <button type="button" className="secondary" onClick={() => filter({ tags: "" })}>清空已选</button>}</div><TagChoice items={libraryTags(library.data.categories, categoryId)} selected={selectedTags} onChange={tags => filter({ tags: tags.length ? JSON.stringify(tags) : "" })} filtering /></section>}
    <div className="list-bar library-result-bar"><small>{(library.data && !videos.initialBusy) ? `${videos.total} 个视频` : "私人空间"}{q ? ` · 标题或标签包含“${q}”` : ""}{activeFilterCount > 0 ? ` · ${activeFilterCount} 个标签条件` : ""}</small>{(q || tagFilter) && <button className="secondary" onClick={() => { setDraft(""); filter({ q: "", tags: "" }); }}>清空搜索与标签</button>}</div>
    {videos.initialBusy ? <Loading /> : videos.error ? <ErrorNotice error={videos.error} retry={videos.reload} /> : <>
      {videos.items.length === 0 ? <Empty title={q || categoryId || tagFilter ? "没有找到匹配的视频" : "这里还没有视频"}>{q || categoryId || tagFilter ? "试试其他标题、分类或标签。所选标签须全部命中。" : "请在上传页上传手机视频，或导入已有公开视频。"}</Empty> : <>
        <div className="video-grid">{videos.items.map(video => <LibraryVideoCard key={video.id} video={video} library={library.data} categoryName={library.data?.categories.find(category => category.id === video.categoryId)?.name ?? "未分类"} />)}</div>
        <div ref={sentinelRef} className="infinite-sentinel" aria-hidden="true" />
        {videos.loadingMore && <div className="infinite-status" role="status"><span className="spinner" />正在加载更多…</div>}
        {videos.moreError && <div className="infinite-status error" role="alert"><span>加载更多失败</span><button className="secondary" onClick={videos.loadMore}>重试</button></div>}
        {!videos.hasMore && videos.items.length > 0 && <div className="infinite-status end">已经到底了，共 {videos.total} 个视频</div>}
      </>}
    </>}
  </div>;
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
