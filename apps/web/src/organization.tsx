import { MAX_ORGANIZATION_LINKS } from "@online-video/shared";
import type { Category, LibraryGroup, Tag } from "@online-video/shared";
import { api } from "./api";

export async function loadOrganizations() {
  const [categories, groups, tags] = await Promise.all([
    api.request<Category[]>("/api/categories?includeArchived=true"),
    api.request<LibraryGroup[]>("/api/groups?includeArchived=true"),
    api.request<Tag[]>("/api/tags?includeArchived=true")
  ]);
  return { categories, groups, tags };
}
export type Organizations = Awaited<ReturnType<typeof loadOrganizations>>;
export const sameSelection = (left: string[], right: string[]) => left.length === right.length && left.every(id => right.includes(id));
export const defaultCategory = (categories: Category[]) => categories.find(c => c.isDefault && !c.archivedAt)?.id ?? categories.find(c => !c.archivedAt)?.id ?? "";
export function MultiChoice({ label, items, selected, onChange, disabled = false, filtering = false }: {
  label: string; items: (LibraryGroup | Tag)[]; selected: string[]; onChange: (ids: string[]) => void; disabled?: boolean; filtering?: boolean;
}) {
  const visible = items.filter(item => filtering || !item.archivedAt || selected.includes(item.id));
  return <fieldset className="multi-choice" disabled={disabled}><legend>{label} <small>已选 {selected.length} / {MAX_ORGANIZATION_LINKS}{filtering ? " · 需同时命中所选项" : " · 可多选"}</small></legend>{visible.length ? <div className="choice-grid">{visible.map(item => <label className="check-row" key={item.id}><input type="checkbox" checked={selected.includes(item.id)} disabled={!selected.includes(item.id) && (!!item.archivedAt && !filtering || selected.length >= MAX_ORGANIZATION_LINKS)} onChange={event => onChange(event.target.checked ? [...selected, item.id] : selected.filter(id => id !== item.id))} /><span>{item.name}{item.archivedAt && <small>已归档{!filtering && "，可取消关联"}</small>}</span></label>)}</div> : <small>暂无{label}，可在组织管理中创建。</small>}{selected.filter(id => !items.some(item => item.id === id)).map(id => <label className="check-row" key={id}><input type="checkbox" checked onChange={() => onChange(selected.filter(value => value !== id))} /><span>关联信息暂不可用 · 可取消选择</span></label>)}</fieldset>;
}
export function OrganizationFields({ organizations, category, groupIds, tagIds, onCategory, onGroups, onTags, disabled = false, categoryLabel = "视频分类" }: {
  organizations: Organizations; category: string; groupIds: string[]; tagIds: string[]; onCategory: (id: string) => void; onGroups: (ids: string[]) => void; onTags: (ids: string[]) => void; disabled?: boolean; categoryLabel?: string;
}) {
  return <><label>{categoryLabel}<select value={category || defaultCategory(organizations.categories)} onChange={event => onCategory(event.target.value)} disabled={disabled}>{organizations.categories.filter(c => !c.archivedAt || c.id === category).map(c => <option key={c.id} value={c.id} disabled={!!c.archivedAt}>{c.name}{c.archivedAt ? "（已归档）" : ""}</option>)}</select></label><MultiChoice label="分组" items={organizations.groups} selected={groupIds} onChange={onGroups} disabled={disabled} /><MultiChoice label="标签" items={organizations.tags} selected={tagIds} onChange={onTags} disabled={disabled} /></>;
}
export function OrganizationBadges({ groupIds = [], tagIds = [], organizations }: { groupIds?: string[]; tagIds?: string[]; organizations: Organizations }) {
  return <div className="organization-badges">{groupIds.map(id => { const group = organizations.groups.find(item => item.id === id); return <span className="badge" key={`group:${id}`}>分组 · {group?.name ?? "信息待加载"}{group?.archivedAt ? "（已归档）" : ""}</span>; })}{tagIds.map(id => { const tag = organizations.tags.find(item => item.id === id); return <span className="badge" key={`tag:${id}`}>#{tag?.name ?? "信息待加载"}{tag?.archivedAt ? "（已归档）" : ""}</span>; })}</div>;
}
