import { useState } from "react";
import type { LibraryConfiguration, LibraryConfigurationCategory, LibraryConfigurationTag, SaveLibraryConfigurationRequest } from "@online-video/shared";
import { api } from "../api";
import { ApiError } from "../api/client";
import { notifyLibraryChanged } from "../library";
import { Empty, ErrorNotice, Icon, Loading, useLoad } from "../ui";
import { useFeedback } from "../feedback";
import "./taxonomy.css";

const payload = (configuration: LibraryConfiguration): SaveLibraryConfigurationRequest => ({ version: configuration.version, categories: configuration.categories.map(({ id, name, enabled, tagIds }) => ({ id, name, enabled, tagIds: [...tagIds] })), tags: configuration.tags.map(({ id, name, enabled }) => ({ id, name, enabled })) });
type Save = (body: SaveLibraryConfigurationRequest, message: string) => Promise<LibraryConfiguration>;
export function ConfigurationPage() {
  const list = useLoad(() => api.request<LibraryConfiguration>("/api/library/configuration"));
  const [kind, setKind] = useState<"categories" | "tags">("categories"); const [name, setName] = useState(""); const [showDeleted, setShowDeleted] = useState(false);
  const [busy, setBusy] = useState(false); const [search, setSearch] = useState(""); const { toast, toastError } = useFeedback();
  const configuration = list.data; const label = kind === "categories" ? "分类" : "标签";
  const save: Save = async (body, message) => {
    setBusy(true);
    try { const saved = await api.request<LibraryConfiguration>("/api/library/configuration", { method: "PUT", body }); notifyLibraryChanged(); list.reload(); toast(message); return saved; }
    catch (error) { toastError(error); if (error instanceof ApiError && error.code === "CONFIG_VERSION_CONFLICT") list.reload(); throw error; }
    finally { setBusy(false); }
  };
  const items = configuration?.[kind].filter(item => (showDeleted || item.enabled) && (!search.trim() || item.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())));
  return <>
    <div className="sci-cat-header-row"><div className="sci-cat-header-info"><div className="eyebrow">SYSTEM TAXONOMY & CONFIGURATION</div><h1 className="sci-cat-title">配置管理</h1><p className="muted">新增分类会显示在视频库筛选栏；新增标签可直接用于上传与编辑视频。修改保存后立即生效。</p></div></div>
    <div className="cfg-hero-bar"><div className="cfg-tabs" role="tablist" aria-label="配置管理模式">{(["categories", "tags"] as const).map(value => <button key={value} role="tab" aria-label={`${value === "categories" ? "分类" : "标签"}配置`} className={`cfg-tab-pill ${kind === value ? "active" : ""}`} aria-selected={kind === value} onClick={() => { setKind(value); setName(""); setSearch(""); setShowDeleted(false); }}><Icon name={value === "categories" ? "folder" : "sparkles"} /><span className="cfg-tab-name">{value === "categories" ? "分类" : "标签"}配置</span><span className="cfg-tab-num">{configuration?.[value].filter(item => item.enabled).length ?? 0}</span></button>)}</div><div className="cfg-search-box"><Icon name="filter" /><input type="search" aria-label={`查询${label}`} placeholder={`搜索${label}名称`} value={search} onChange={event => setSearch(event.target.value)} /></div></div>
    {configuration && !configuration.writable && <div className="notice warning">配置当前只读，无法保存，请检查服务端配置文件权限。</div>}
    <form className="cfg-list-create-bar" onSubmit={async event => {
      event.preventDefault(); if (!configuration || !name.trim()) return;
      const requested = name.trim(); const body = payload(configuration);
      if (kind === "categories") body.categories.push({ name: requested, enabled: true, tagIds: configuration.tags.filter(tag => tag.enabled).map(tag => tag.id) }); else body.tags.push({ name: requested, enabled: true });
      try {
        await save(body, kind === "categories" ? `分类“${requested}”已新增，可在视频库筛选。` : `标签“${requested}”已新增，可在上传和编辑视频时选择。`);
        setName("");
      } catch { /* save 已显示保存失败。 */ }
    }}><input className="sci-input" aria-label={`新建${label}名称`} placeholder={`输入新${label}名称`} value={name} onChange={event => setName(event.target.value)} maxLength={100} required disabled={busy || !configuration?.writable} /><button className="button" disabled={busy || !configuration?.writable || !name.trim()} type="submit"><Icon name="check" /><span>{busy ? "正在写入…" : `添加${label}`}</span></button></form>
    <section className="cfg-data-section taxonomy-section"><div className="cfg-section-bar"><div><span className="cfg-section-title">已有{label}</span><small className="muted taxonomy-total">{search ? `匹配到 ${items?.length ?? 0} 项` : `共 ${items?.length ?? 0} 项`}</small></div><label className="check-row taxonomy-deleted-toggle"><input type="checkbox" checked={showDeleted} onChange={event => setShowDeleted(event.target.checked)} />显示已删除{label}</label></div>{!configuration && list.busy ? <Loading /> : list.error ? <ErrorNotice error={list.error} retry={list.reload} /> : configuration && (items?.length === 0 ? <Empty title={search ? `未找到匹配${label}` : `暂无${label}`}>使用上方输入框新增{label}。</Empty> : <div className="configuration-table-scroll"><table className="cfg-list-table"><thead><tr><th className="cfg-col-name">{label}名称</th>{kind === "categories" && <th className="cfg-col-sort">显示顺序</th>}<th className="cfg-col-state">状态 / 数量</th><th className="cfg-col-actions">操作</th></tr></thead><tbody>{items?.map(item => kind === "categories" ? <CategoryRow key={`${configuration.version}:${item.id}`} configuration={configuration} category={item as LibraryConfigurationCategory} busy={busy} save={save} /> : <TagRow key={`${configuration.version}:${item.id}`} configuration={configuration} tag={item as LibraryConfigurationTag} busy={busy} save={save} />)}</tbody></table></div>)}</section>
  </>;
}
function CategoryRow({ configuration, category, busy, save }: { configuration: LibraryConfiguration; category: LibraryConfigurationCategory; busy: boolean; save: Save }) {
  const { confirm } = useFeedback();
  const initialOrder = configuration.categories.findIndex(value => value.id === category.id); const [name, setName] = useState(category.name); const [order, setOrder] = useState(initialOrder); const [tagIds, setTagIds] = useState(category.tagIds);
  const changed = name.trim() !== category.name || order !== initialOrder || JSON.stringify(tagIds) !== JSON.stringify(category.tagIds);
  const update = async (enabled = category.enabled) => {
    const toggling = enabled !== category.enabled; const deleting = toggling && !enabled; const rename = !toggling && name.trim() !== category.name; const removed = !toggling ? category.tagIds.filter(id => !tagIds.includes(id)) : []; const impact = deleting || rename || removed.length > 0;
    const description = deleting ? `删除后，${category.videoCount} 个视频归入“未分类”，该分类从视频库筛选及上传选项移出。视频、封面和已有标签保留。${category.uploadCount ? `该分类的 ${category.uploadCount} 个上传任务完成后也归入“未分类”。` : ""}可在“显示已删除分类”中恢复，恢复不会自动搬回视频。` : `修改后立即更新视频库及上传选项。${category.videoCount ? `${category.videoCount} 个视频显示新的分类名称。` : ""}调整可选标签时，视频的已有标签保留。`;
    if (impact && !await confirm({ title: deleting ? `删除分类“${category.name}”` : `确认修改分类“${category.name}”`, message: description, confirmLabel: deleting ? "确认删除分类" : "确认保存", danger: deleting })) return;
    const body = payload(configuration); const current = body.categories.find(item => item.id === category.id)!; current.name = toggling ? category.name : name.trim(); current.enabled = enabled; current.tagIds = toggling ? category.tagIds : tagIds;
    if (!toggling) { body.categories.splice(initialOrder, 1); body.categories.splice(Math.max(0, Math.min(body.categories.length, order)), 0, current); } body.confirmImpact = impact;
    try { await save(body, deleting ? `分类“${category.name}”已删除，${category.videoCount} 个视频已归入未分类。` : toggling ? `分类“${category.name}”已恢复。` : `分类“${name.trim()}”已保存，视频库与上传选项已同步。`); } catch { /* 保存失败只弹错误消息，不虚报成功。 */ }
  };
  return <tr className={!category.enabled ? "archived" : ""} data-category-id={category.id}><td className="cfg-col-name"><input className="sci-input cfg-name-input" aria-label={`重命名分类 ${category.name}`} value={name} onChange={event => setName(event.target.value)} maxLength={100} disabled={busy || !configuration.writable || category.isDefault} />{category.isDefault && <div className="cfg-default-tip">系统默认分类</div>}<details className="taxonomy-tag-options"><summary>可选标签 · {configuration.tags.filter(tag => tag.enabled && tagIds.includes(tag.id)).length} 个</summary><fieldset className="configuration-tag-range" disabled={busy || !configuration.writable}><legend>{category.name} 的可选标签</legend>{configuration.tags.filter(tag => tag.enabled).map(tag => <label className="check-row" key={tag.id}><input type="checkbox" aria-label={`${category.name} 可选标签 ${tag.name}`} checked={tagIds.includes(tag.id)} onChange={event => setTagIds(event.target.checked ? [...tagIds, tag.id] : tagIds.filter(value => value !== tag.id))} /><span>{tag.name}</span></label>)}{configuration.tags.every(tag => !tag.enabled) && <small>暂无标签，可切换标签配置新增。</small>}</fieldset></details></td><td className="cfg-col-sort"><input className="sci-input cfg-sort-input" aria-label={`${category.name} 排序位置`} title="0 为最前，保存后按此位置排序" type="number" min={0} max={configuration.categories.length - 1} step={1} value={order} onChange={event => setOrder(Number(event.target.value))} disabled={busy || !configuration.writable} /></td><td className="cfg-col-state"><span className={`cfg-state-tag ${category.enabled ? "active" : "archived"}`}>{category.enabled ? "使用中" : "已删除"}</span><small>{category.videoCount} 个视频{category.uploadCount ? ` · ${category.uploadCount} 个任务` : ""}</small></td><td className="cfg-col-actions"><button className="secondary sci-card-btn cfg-save-btn" disabled={busy || !configuration.writable || !changed || !name.trim() || !Number.isInteger(order) || order < 0} onClick={() => void update()}>保存分类</button>{!category.isDefault && <button className={`secondary sci-card-btn ${category.enabled ? "cfg-archive-btn" : "cfg-restore-btn"}`} disabled={busy || !configuration.writable} onClick={() => void update(!category.enabled)}>{category.enabled ? "删除分类" : "恢复分类"}</button>}{!category.enabled && <small>恢复不会自动搬回视频</small>}</td></tr>;
}
function TagRow({ configuration, tag, busy, save }: { configuration: LibraryConfiguration; tag: LibraryConfigurationTag; busy: boolean; save: Save }) {
  const { confirm } = useFeedback();
  const [name, setName] = useState(tag.name);
  const categories = configuration.categories.filter(category => tag.categoryIds.includes(category.id));
  const update = async (enabled = tag.enabled) => {
    const toggling = enabled !== tag.enabled; const deleting = toggling && !enabled; const rename = !toggling && name.trim() !== tag.name; const impact = rename || deleting;
    if (impact && !await confirm({ title: `${deleting ? "删除" : "修改"}标签“${tag.name}”`, message: deleting ? `删除后，此标签不再出现在上传与编辑的可选标签中。${tag.videoCount} 个视频的已有标签保留。可在“显示已删除标签”中恢复。` : `保存后，${tag.videoCount} 个视频的标签名称也会更新为“${name.trim()}”。`, confirmLabel: deleting ? "确认删除标签" : "确认保存", danger: deleting })) return;
    const body = payload(configuration); const current = body.tags.find(item => item.id === tag.id)!; current.name = toggling ? tag.name : name.trim(); current.enabled = enabled; body.confirmImpact = impact;
    try { await save(body, deleting ? `标签“${tag.name}”已删除，视频的已有标签保留。` : toggling ? `标签“${tag.name}”已恢复。` : `标签“${name.trim()}”已保存。`); } catch { /* 父级显示错误。 */ }
  };
  return <tr className={!tag.enabled ? "archived" : ""} data-tag-id={tag.id}><td className="cfg-col-name"><input className="sci-input cfg-name-input" aria-label={`重命名标签 ${tag.name}`} value={name} onChange={event => setName(event.target.value)} maxLength={100} disabled={busy || !configuration.writable} /><small>可用于：{categories.filter(category => category.enabled).map(category => category.name).join("、") || "暂无分类；新增分类后即可选择"}</small></td><td className="cfg-col-state"><span className={`cfg-state-tag ${tag.enabled ? "active" : "archived"}`}>{tag.enabled ? "使用中" : "已删除"}</span><small>{tag.videoCount} 个视频{tag.uploadCount ? ` · ${tag.uploadCount} 个任务` : ""}</small></td><td className="cfg-col-actions"><button className="secondary sci-card-btn cfg-save-btn" disabled={busy || !configuration.writable || !name.trim() || name.trim() === tag.name} onClick={() => void update()}>保存标签</button><button className={`secondary sci-card-btn ${tag.enabled ? "cfg-archive-btn" : "cfg-restore-btn"}`} disabled={busy || !configuration.writable} onClick={() => void update(!tag.enabled)}>{tag.enabled ? "删除标签" : "恢复标签"}</button></td></tr>;
}
