import { MAX_ORGANIZATION_LINKS } from "@online-video/shared";
import { useEffect, useState } from "react";
import type { LibraryConfig } from "@online-video/shared";
import { api } from "./api";
import { defaultLibraryCategory, libraryTags } from "./library-data";
import { Empty, ErrorNotice, Loading, useLoad } from "./ui";

export const loadLibrary = () => api.request<LibraryConfig>("/api/library");
const LIBRARY_CHANGE_CHANNEL = "online-video-library-configuration";
const LIBRARY_CHANGE_STORAGE = "ov.library-configuration-revision";
export function notifyLibraryChanged() {
  const revision = crypto.randomUUID();
  window.dispatchEvent(new CustomEvent("library-configuration-changed", { detail: { revision } }));
  // 消息只携带无业务内容的版本提示，各页面仍经鉴权重新读取服务端配置。
  try { if (typeof BroadcastChannel !== "undefined") { const channel = new BroadcastChannel(LIBRARY_CHANGE_CHANNEL); channel.postMessage({ revision }); channel.close(); } } catch { /* 下方 storage 通知兼容不可用的广播通道。 */ }
  try { localStorage.setItem(LIBRARY_CHANGE_STORAGE, revision); } catch { /* 浏览器禁用本地存储时仍可用广播或重新聚焦刷新。 */ }
}
export function useLibraryRevision() {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let lastRevision = ""; let channel: BroadcastChannel | undefined;
    const refresh = () => setRevision(value => value + 1);
    const receive = (value: unknown) => { if (typeof value !== "string" || !/^[a-f0-9-]{36}$/.test(value) || value === lastRevision) return; lastRevision = value; refresh(); };
    const changed = (event: Event) => receive((event as CustomEvent<{ revision?: unknown }>).detail?.revision);
    const stored = (event: StorageEvent) => { if (event.key === LIBRARY_CHANGE_STORAGE) receive(event.newValue); };
    try { if (typeof BroadcastChannel !== "undefined") { channel = new BroadcastChannel(LIBRARY_CHANGE_CHANNEL); channel.onmessage = event => receive((event.data as { revision?: unknown } | null)?.revision); } } catch { /* 兼容 storage 通知及聚焦刷新。 */ }
    window.addEventListener("library-configuration-changed", changed); window.addEventListener("storage", stored); window.addEventListener("focus", refresh);
    return () => { channel?.close(); window.removeEventListener("library-configuration-changed", changed); window.removeEventListener("storage", stored); window.removeEventListener("focus", refresh); };
  }, []);
  return revision;
}
export function TagChoice({ items, selected, onChange, disabled = false, filtering = false }: { items: string[]; selected: string[]; onChange: (tags: string[]) => void; disabled?: boolean; filtering?: boolean }) {
  const visible = [...new Set([...items, ...selected])];
  return <fieldset className="multi-choice" disabled={disabled}><legend>标签 <small>已选 {selected.length} / {MAX_ORGANIZATION_LINKS}{filtering ? " · 需同时命中所选项" : " · 可多选"}</small></legend>{visible.length ? <div className="choice-grid">{visible.map(tag => <label className="check-row" key={tag}><input type="checkbox" checked={selected.includes(tag)} disabled={!selected.includes(tag) && selected.length >= MAX_ORGANIZATION_LINKS} onChange={event => onChange(event.target.checked ? [...selected, tag] : selected.filter(value => value !== tag))} /><span>{tag}{!items.includes(tag) && <small>历史标签，可保留或取消</small>}</span></label>)}</div> : <small>此分类暂无配置标签。</small>}</fieldset>;
}
export function LibraryFields({ library, category, tags, onCategory, onTags, disabled = false }: { library: LibraryConfig; category: string; tags: string[]; onCategory: (id: string) => void; onTags: (tags: string[]) => void; disabled?: boolean }) {
  const categoryId = category || defaultLibraryCategory(library.categories);
  return <><label>视频分类<select value={categoryId} onChange={event => { onCategory(event.target.value); onTags([]); }} disabled={disabled} required>{!categoryId && <option value="">请先配置分类</option>}{library.categories.map(item => <option key={item.id} value={item.id} disabled={item.enabled === false}>{item.name}{item.enabled === false ? "（已停用）" : ""}</option>)}</select></label><TagChoice items={libraryTags(library.categories, categoryId)} selected={tags} onChange={onTags} disabled={disabled} /></>;
}
export function TagBadges({ tags = [] }: { tags?: string[] }) { return <div className="organization-badges">{tags.map(tag => <span className="badge" key={tag}>#{tag}</span>)}</div>; }
export function LibraryConfigPage() {
  const library = useLoad(loadLibrary);
  return <><div className="eyebrow">A PLACE FOR EVERY MOMENT</div><h1>分类与标签</h1><p className="muted">分类和可选标签来自配置，按配置顺序展示。修改配置后重启后端并刷新页面生效。</p><section className="stack section-space"><h2>配置分类</h2>{library.busy ? <Loading /> : library.error ? <ErrorNotice error={library.error} retry={library.reload} /> : library.data?.categories.length === 0 ? <Empty title="暂无配置分类">配置分类后即可上传或登记视频。</Empty> : library.data?.categories.map(category => <article className="panel stack" key={category.id}><h3>{category.name}{category.enabled === false ? "（已停用）" : ""}</h3><TagBadges tags={category.tags} />{category.tags.length === 0 && <small>暂无标签</small>}</article>)}</section></>;
}
