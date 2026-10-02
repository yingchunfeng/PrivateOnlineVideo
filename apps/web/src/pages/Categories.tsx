import { useState } from "react";
import type { Category } from "@online-video/shared";
import { api } from "../api";
import { Empty, ErrorNotice, Loading, useLoad } from "../ui";

export function CategoriesPage() {
  const list = useLoad(() => api.request<Category[]>("/api/categories"));
  const [name, setName] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(); const [message, setMessage] = useState("");
  return <><div className="eyebrow">A PLACE FOR EVERY MOMENT</div><h1>分类管理</h1><p className="muted">用简单分类整理视频。未分类的视频仍能在视频库找到。</p><form className="panel stack" onSubmit={async event => { event.preventDefault(); setBusy(true); setError(undefined); setMessage(""); try { await api.request<Category>("/api/categories", { method: "POST", body: { name: name.trim() } }); setName(""); setMessage("分类已创建"); list.reload(); } catch (err) { setError(err); } finally { setBusy(false); } }}><h2>新建分类</h2><label>分类名称<input value={name} onChange={e => setName(e.target.value)} maxLength={100} required disabled={busy} /></label><button disabled={busy || !name.trim()} type="submit">{busy ? "正在创建…" : "新建分类"}</button></form>{error !== undefined && <ErrorNotice error={error} />}{message && <div className="notice" role="status">{message}</div>}<section className="stack section-space"><h2>已有分类</h2>{list.busy ? <Loading /> : list.error ? <ErrorNotice error={list.error} retry={list.reload} /> : list.data?.length === 0 ? <Empty title="分类暂不可用">请由后端检查默认分类初始化。</Empty> : list.data?.slice().sort((a, b) => a.sortOrder - b.sortOrder).map(category => <CategoryEditor key={`${category.id}:${category.name}`} category={category} onSaved={list.reload} />)}</section></>;
}
function CategoryEditor({ category, onSaved }: { category: Category; onSaved: () => void }) {
  const [name, setName] = useState(category.name); const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>();
  return <form className="panel stack" onSubmit={async event => { event.preventDefault(); setBusy(true); setError(undefined); try { await api.request<Category>(`/api/categories/${encodeURIComponent(category.id)}`, { method: "PATCH", body: { name: name.trim() } }); onSaved(); } catch (err) { setError(err); } finally { setBusy(false); } }}><label>{category.name}<input aria-label={`重命名 ${category.name}`} value={name} maxLength={100} onChange={e => setName(e.target.value)} required disabled={busy} /></label>{error !== undefined && <ErrorNotice error={error} />}<button className="secondary" type="submit" disabled={busy || name.trim() === category.name || !name.trim()}>{busy ? "正在保存…" : "保存名称"}</button></form>;
}
