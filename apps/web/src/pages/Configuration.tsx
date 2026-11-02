import { useRef, useState } from "react";
import type { LibraryConfiguration, LibraryConfigurationCategory, LibraryConfigurationTag, SaveLibraryConfigurationRequest } from "@online-video/shared";
import { api } from "../api";
import { ApiError } from "../api/client";
import { notifyLibraryChanged } from "../library";
import { Empty, ErrorNotice, Icon, Loading, Modal, TableContainer, useLoad } from "../ui";
import { useFeedback } from "../feedback";
import "./taxonomy.css";

const payload = (configuration: LibraryConfiguration): SaveLibraryConfigurationRequest => ({ version: configuration.version, categories: configuration.categories.map(({ id, name, enabled, tagIds }) => ({ id, name, enabled, tagIds: [...tagIds] })), tags: configuration.tags.map(({ id, name, enabled }) => ({ id, name, enabled })) });
type Kind = "categories" | "tags";
interface Editor { kind: Kind; configuration: LibraryConfiguration; id?: string; name: string; order: string; tagIds: string[] }
export function ConfigurationPage() {
  const list = useLoad(() => api.request<LibraryConfiguration>("/api/library/configuration"));
  const [kind, setKind] = useState<Kind>("categories"); const [showDeleted, setShowDeleted] = useState(false);
  const [busy, setBusy] = useState(false); const [search, setSearch] = useState(""); const { toast, toastError, confirm } = useFeedback();
  const saving = useRef(false);
  const [editor, setEditor] = useState<Editor>(); const [editorError, setEditorError] = useState<unknown>();
  const configuration = list.data; const label = kind === "categories" ? "分类" : "标签";
  const save = async (body: SaveLibraryConfigurationRequest, message: string) => {
    try { const saved = await api.request<LibraryConfiguration>("/api/library/configuration", { method: "PUT", body }); notifyLibraryChanged(); list.reload(); toast(message); return saved; }
    catch (error) { toastError(error); if (error instanceof ApiError && error.code === "CONFIG_VERSION_CONFLICT") list.reload(); throw error; }
  };
  const openEditor = (item?: LibraryConfigurationCategory | LibraryConfigurationTag) => {
    if (!configuration) return;
    setEditorError(undefined);
    // 草稿绑定打开时的版本；冲突后只允许用户显式更新基线，不静默覆盖其他修改。
    setEditor({ kind, configuration, ...(item ? { id: item.id } : {}), name: item?.name ?? "", order: String(item ? configuration.categories.findIndex(value => value.id === item.id) : configuration.categories.length), tagIds: item && "tagIds" in item ? [...item.tagIds] : configuration.tags.filter(tag => tag.enabled).map(tag => tag.id) });
  };
  const toggle = async (item: LibraryConfigurationCategory | LibraryConfigurationTag) => {
    if (!configuration || saving.current) return;
    saving.current = true;
    try {
      const deleting = item.enabled;
      if (deleting && !await confirm({ title: `删除${label}“${item.name}”`, message: kind === "categories" ? `删除后，${item.videoCount} 个视频归入“未分类”，该分类从视频库筛选及上传选项移出。视频、封面和已有标签保留。${item.uploadCount ? `该分类的 ${item.uploadCount} 个上传任务完成后也归入“未分类”。` : ""}可在“显示已删除分类”中恢复，恢复不会自动搬回视频。` : `删除后，此标签不再出现在上传与编辑的可选标签中。${item.videoCount} 个视频的已有标签保留。可在“显示已删除标签”中恢复。`, confirmLabel: `确认删除${label}`, danger: true })) return;
      setBusy(true);
      const body = payload(configuration); body[kind].find(value => value.id === item.id)!.enabled = !item.enabled; body.confirmImpact = deleting;
      await save(body, `${label}“${item.name}”已${deleting ? "删除" : "恢复"}。${deleting ? "原有视频与标签保留。" : kind === "categories" ? "恢复不会自动搬回视频。" : ""}`);
    } catch { /* save 已提示失败，不更改行状态。 */ }
    finally { saving.current = false; setBusy(false); }
  };
  const submit = async () => {
    if (!editor || saving.current || !editor.name.trim()) return;
    const base = editor.configuration; const category = base.categories.find(item => item.id === editor.id);
    const order = Number(editor.order); const max = base.categories.length - (editor.id ? 1 : 0);
    if (editor.kind === "categories" && (!editor.order.trim() || !Number.isInteger(order) || order < 0 || order > max)) { setEditorError(new Error(`显示顺序须为 0 至 ${max} 的整数。`)); return; }
    saving.current = true; setEditorError(undefined);
    try {
      const body = payload(base); const requested = editor.name.trim(); const itemLabel = editor.kind === "categories" ? "分类" : "标签";
      const previous = base[editor.kind].find(item => item.id === editor.id);
      const impact = !!previous && (requested !== previous.name || !!category?.tagIds.some(id => !editor.tagIds.includes(id)));
      if (impact && !await confirm({ title: `确认修改${itemLabel}“${previous.name}”`, message: editor.kind === "categories" ? `修改后立即更新视频库及上传选项。${previous.videoCount} 个视频显示新的分类名称。调整可选标签时，视频的已有标签保留。` : `保存后，${previous.videoCount} 个视频的标签名称也会更新为“${requested}”。`, confirmLabel: "确认保存" })) return;
      setBusy(true);
      if (editor.kind === "categories") {
        const index = body.categories.findIndex(item => item.id === editor.id);
        const current = index < 0 ? { name: requested, enabled: true, tagIds: [...editor.tagIds] } : { ...body.categories[index]!, name: category?.isDefault ? category.name : requested, tagIds: [...editor.tagIds] };
        if (index >= 0) body.categories.splice(index, 1);
        body.categories.splice(order, 0, current);
      } else if (editor.id) body.tags.find(item => item.id === editor.id)!.name = requested;
      else body.tags.push({ name: requested, enabled: true });
      body.confirmImpact = impact;
      await save(body, `${itemLabel}“${requested}”已${editor.id ? "保存" : "新增"}，视频库与上传选项已同步。`); setEditor(undefined);
    } catch (error) { setEditorError(error); }
    finally { saving.current = false; setBusy(false); }
  };
  const items = configuration?.[kind].filter(item => (showDeleted || item.enabled) && (!search.trim() || item.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())));
  return <>
    <div className="page-head"><div><h1>配置管理</h1></div><button className="button" disabled={busy || !configuration?.writable} onClick={() => openEditor()}><Icon name="folder" />新增{label}</button></div>
    <div className="management-toolbar taxonomy-toolbar"><div className="taxonomy-tabs" role="tablist" aria-label="配置管理模式">{(["categories", "tags"] as const).map(value => <button key={value} role="tab" aria-label={`${value === "categories" ? "分类" : "标签"}配置`} className={kind === value ? "selected" : "secondary"} aria-selected={kind === value} onClick={() => { setKind(value); setSearch(""); setShowDeleted(false); }}>{value === "categories" ? "分类" : "标签"}配置 <small>{configuration?.[value].filter(item => item.enabled).length ?? 0}</small></button>)}</div><label className="taxonomy-query">查询{label}<input type="search" placeholder={`搜索${label}名称`} value={search} onChange={event => setSearch(event.target.value)} /></label><label className="check-row taxonomy-deleted-toggle"><input type="checkbox" checked={showDeleted} onChange={event => setShowDeleted(event.target.checked)} />显示已删除{label}</label></div>
    {configuration && !configuration.writable && <div className="notice warning">配置当前只读，无法保存，请检查服务端配置文件权限。</div>}
    <section className="taxonomy-section"><div className="list-bar"><strong>已有{label}</strong><small>{search ? "匹配到" : "共"} {items?.length ?? 0} 项</small></div>{!configuration && list.busy ? <Loading /> : list.error ? <ErrorNotice error={list.error} retry={list.reload} /> : configuration && (items?.length === 0 ? <Empty title={search ? `未找到匹配${label}` : `暂无${label}`}>点击“新增{label}”填写信息。</Empty> : <TableContainer label={`${label}列表`}><table className="management-table taxonomy-table"><thead><tr><th scope="col">{label}名称</th>{kind === "categories" && <th scope="col">显示顺序</th>}<th scope="col">状态 / 视频数量</th><th scope="col">{kind === "categories" ? "可选标签" : "可用分类"}</th><th scope="col">操作</th></tr></thead><tbody>{items?.map(item => <tr key={item.id} className={!item.enabled ? "archived" : ""} {...(kind === "categories" ? { "data-category-id": item.id } : { "data-tag-id": item.id })}><td><strong>{item.name}</strong>{"isDefault" in item && item.isDefault && <small>系统默认分类</small>}</td>{kind === "categories" && <td>{configuration.categories.findIndex(value => value.id === item.id)}</td>}<td><span className={`management-state ${item.enabled ? "active" : "archived"}`}>{item.enabled ? "使用中" : "已删除"}</span><small>{item.videoCount} 个视频{item.uploadCount ? ` · ${item.uploadCount} 个任务` : ""}</small></td><td><div className="taxonomy-tag-list">{kind === "categories" ? configuration.tags.filter(tag => tag.enabled && (item as LibraryConfigurationCategory).tagIds.includes(tag.id)).map(tag => <span className="management-tag" key={tag.id}>{tag.name}</span>) : configuration.categories.filter(category => category.enabled && (item as LibraryConfigurationTag).categoryIds.includes(category.id)).map(category => <span className="management-tag" key={category.id}>{category.name}</span>)}</div>{(kind === "categories" ? !configuration.tags.some(tag => tag.enabled && (item as LibraryConfigurationCategory).tagIds.includes(tag.id)) : !configuration.categories.some(category => category.enabled && (item as LibraryConfigurationTag).categoryIds.includes(category.id))) && <small>暂无{kind === "categories" ? "标签" : "分类"}</small>}</td><td><div className="management-actions"><button className="secondary" disabled={busy || !configuration.writable} onClick={() => openEditor(item)}>编辑{label}</button>{!("isDefault" in item && item.isDefault) && <button className={`secondary ${item.enabled ? "taxonomy-danger" : ""}`} disabled={busy || !configuration.writable} onClick={() => void toggle(item)}>{item.enabled ? "删除" : "恢复"}{label}</button>}</div>{!item.enabled && kind === "categories" && <small>恢复不会自动搬回视频</small>}</td></tr>)}</tbody></table></TableContainer>)}</section>
    {editor && <Modal title={`${editor.id ? "编辑" : "新增"}${editor.kind === "categories" ? "分类" : "标签"}`} description="保存后同步视频库、上传和视频编辑的可选项。取消不会写入。" busy={busy} onClose={() => setEditor(undefined)} footer={<><button className="secondary" disabled={busy} onClick={() => setEditor(undefined)}>取消</button><button type="submit" form="taxonomy-editor" disabled={busy || !editor.name.trim() || !editor.configuration.writable}>{busy ? "正在保存…" : "保存"}</button></>}><form id="taxonomy-editor" className="management-form" onSubmit={event => { event.preventDefault(); void submit(); }}><label className="management-field"><span>{editor.kind === "categories" ? "分类" : "标签"}名称 <span aria-hidden="true">*</span></span><input required maxLength={100} value={editor.name} disabled={busy || !!editor.configuration.categories.find(item => item.id === editor.id)?.isDefault} onChange={event => setEditor({ ...editor, name: event.target.value })} />{editor.configuration.categories.find(item => item.id === editor.id)?.isDefault && <small>系统默认分类不可重命名或删除。</small>}</label>{editor.kind === "categories" && <><label className="management-field"><span>显示顺序 <span aria-hidden="true">*</span></span><input type="number" min={0} max={editor.configuration.categories.length - (editor.id ? 1 : 0)} step={1} required value={editor.order} disabled={busy} onChange={event => setEditor({ ...editor, order: event.target.value })} /><small>0 为最前，保存后按此位置排序。</small></label><fieldset className="taxonomy-editor-tags" disabled={busy}><legend>可选标签</legend>{editor.configuration.tags.filter(tag => tag.enabled).map(tag => <label className="check-row" key={tag.id}><input type="checkbox" checked={editor.tagIds.includes(tag.id)} onChange={event => setEditor({ ...editor, tagIds: event.target.checked ? [...editor.tagIds, tag.id] : editor.tagIds.filter(id => id !== tag.id) })} />{tag.name}</label>)}{editor.configuration.tags.every(tag => !tag.enabled) && <small>暂无标签，可在标签配置中新增。</small>}</fieldset></>}{editorError !== undefined && <ErrorNotice error={editorError} />}{editorError instanceof ApiError && editorError.code === "CONFIG_VERSION_CONFLICT" && <div className="notice warning"><p>填写内容已保留。请核对最新列表后显式更新版本，再保存；不会自动覆盖其他修改。</p><button className="secondary" type="button" disabled={busy || !configuration || configuration.version === editor.configuration.version || !!editor.id && !configuration[editor.kind].some(item => item.id === editor.id)} onClick={() => { if (!configuration) return; setEditor({ ...editor, configuration, tagIds: editor.tagIds.filter(id => configuration.tags.some(tag => tag.id === id)) }); setEditorError(undefined); }}>使用最新版本重试</button>{list.error !== undefined && <ErrorNotice error={list.error} retry={list.reload} />}</div>}</form></Modal>}
  </>;
}
