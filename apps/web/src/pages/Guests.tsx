import { useEffect, useRef, useState } from "react";
import { GUEST_DEFAULT_PERMISSIONS, GUEST_PERMISSIONS, GUEST_PERMISSION_LABELS } from "@online-video/shared";
import type { CreateGuestRequest, GuestCredential, GuestPermission, GuestRecord } from "@online-video/shared";
import { api } from "../api";
import { guestsApi } from "../api/guests";
import { ApiError } from "../api/client";
import { useFeedback } from "../feedback";
import { ErrorNotice, Loading, Modal, TableContainer, date, useLoad } from "../ui";
import "./guest-management.css";

const requests = guestsApi(api);
const pages: GuestPermission[] = ["library", "upload", "pages", "tasks", "configuration"];
const localTime = (value: string | number) => {
  const time = new Date(value); return new Date(time.getTime() - time.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
interface Draft { id?: string; version?: number; name: string; expiresAt: string; permissions: GuestPermission[] }
const permissionHint: Record<GuestPermission, string> = {
  library: "查看共享视频库及播放", upload: "上传、导入及完成自己的任务", pages: "仅个人外观与动态星空", tasks: "仅查看和操作自己的上传任务",
  configuration: "管理共享分类与标签", video_edit: "标题、分类、标签、封面及时长补采", video_delete: "仅删除数据库记录，不删除 OSS 内容"
};

export function GuestsPage() {
  const load = useLoad(requests.list); const { confirm } = useFeedback();
  const [items, setItems] = useState<GuestRecord[]>([]); const [filter, setFilter] = useState("all"); const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<Draft>(); const [delivery, setDelivery] = useState<GuestCredential>();
  const [error, setError] = useState<unknown>(); const [notice, setNotice] = useState(""); const [copyNotice, setCopyNotice] = useState("");
  const [busy, setBusy] = useState(false); const [now, setNow] = useState(Date.now());
  const clockOffset = useRef(0); const saving = useRef(false); const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (load.data) { clockOffset.current = Date.parse(load.data.serverTime) - Date.now(); setItems(load.data.items); setNow(Date.now() + clockOffset.current); }
  }, [load.data]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now() + clockOffset.current), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible" && !saving.current) load.reload(); };
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, []);
  const active = (guest: GuestRecord) => guest.status === "active" && !guest.revokedAt && Date.parse(guest.expiresAt) > now;
  const replace = (guest: GuestRecord) => { clockOffset.current = Date.parse(guest.serverTime) - Date.now(); setItems(current => [guest, ...current.filter(item => item.id !== guest.id)]); setNow(Date.now() + clockOffset.current); };
  const open = (guest?: GuestRecord) => { setError(undefined); setNotice(""); setDraft(guest ? { id: guest.id, version: guest.version, name: guest.name, expiresAt: localTime(guest.expiresAt), permissions: [...guest.permissions] } : { name: "", expiresAt: localTime(now + 86_400_000), permissions: [...GUEST_DEFAULT_PERMISSIONS] }); };
  const save = async () => {
    if (!draft || saving.current) return;
    setError(undefined); const expiry = Date.parse(draft.expiresAt);
    if (!Number.isFinite(expiry)) { setError(new Error("请输入有效的到期时间")); return; }
    const expiresAt = new Date(expiry).toISOString();
    if (!draft.name.trim()) { setError(new Error("请输入访客名称")); return; }
    if (Date.parse(expiresAt) <= Date.now() + clockOffset.current) { setError(new Error("到期时间必须晚于服务器当前时间")); return; }
    if (!draft.permissions.some(permission => pages.includes(permission))) { setError(new Error("请至少勾选一个可访问页面")); return; }
    if (draft.permissions.some(permission => permission === "video_edit" || permission === "video_delete") && !draft.permissions.includes("library")) { setError(new Error("视频编辑或删除权限需要同时勾选首页库")); return; }
    const input: CreateGuestRequest = { name: draft.name.trim(), expiresAt, permissions: draft.permissions };
    saving.current = true; setBusy(true);
    try {
      if (draft.id) { const guest = await requests.update(draft.id, { ...input, version: draft.version! }); if (!alive.current) return; replace(guest); setDraft(undefined); setNotice("访客已更新；已登录会话将在服务端逐请求应用最新权限与期限。"); }
      else { const result = await requests.create(input); if (!alive.current) return; replace(result.guest); setDraft(undefined); setCopyNotice(""); setDelivery(result); }
    } catch (failure) { if (alive.current) setError(failure); }
    finally { saving.current = false; if (alive.current) setBusy(false); }
  };
  const refreshVersion = async () => {
    if (!draft?.id || saving.current) return;
    saving.current = true; setBusy(true);
    try { const latest = await requests.list(); if (!alive.current) return; const current = latest.items.find(item => item.id === draft.id); setItems(latest.items);
      if (!current || current.status !== "active" || current.revokedAt || Date.parse(current.expiresAt) <= Date.parse(latest.serverTime)) throw new Error("此访客已失效，不能恢复；请取消并新增访客");
      setDraft({ ...draft, version: current.version }); setError(undefined); setNotice("已读取最新版本；请核对保留的草稿后再保存。");
    } catch (failure) { if (alive.current) setError(failure); }
    finally { saving.current = false; if (alive.current) setBusy(false); }
  };
  const action = async (guest: GuestRecord, kind: "reset" | "revoke") => {
    if (saving.current) return;
    const accepted = await confirm({ title: kind === "reset" ? "重置访客临时密码" : "提前失效访客", message: kind === "reset" ? `重置“${guest.name}”后，旧密码及全部旧会话立即失效。新密码仅展示一次，需重新交付。` : `“${guest.name}”的全部会话将失效，不能继续站内操作，且此凭证不能恢复。已复制的 OSS 公共地址不会撤回。`, confirmLabel: kind === "reset" ? "确认重置密码" : "确认提前失效", danger: true });
    if (!accepted || saving.current || !alive.current) return;
    saving.current = true; setBusy(true); setError(undefined); setNotice("");
    try {
      if (kind === "reset") { const result = await requests.reset(guest.id, guest.version); if (!alive.current) return; replace(result.guest); setCopyNotice(""); setDelivery(result); }
      else { const next = await requests.revoke(guest.id, guest.version); if (!alive.current) return; replace(next); setNotice(`“${guest.name}”已提前失效，全部相关会话已撤销。`); }
    } catch (failure) { if (alive.current) setError(failure); }
    finally { saving.current = false; if (alive.current) setBusy(false); }
  };
  const filtered = items.filter(guest => (filter === "all" || (filter === "active") === active(guest)) && guest.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const copyDelivery = async () => {
    if (!delivery) return;
    const text = `访客登录：${window.location.origin}/guest/login\n访客名称：${delivery.guest.name}\n临时密码：${delivery.password}\n到期时间：${date(delivery.guest.expiresAt)}（${timezone}）`;
    try { await navigator.clipboard.writeText(text); setCopyNotice("已复制访客登录入口、临时密码和到期时间，请私下交付。"); }
    catch { setCopyNotice("复制失败，请选中下方文本手动复制；关闭后不能再次读取此密码。"); }
  };
  return <>
    <div className="page-head"><div><h1>访客管理</h1></div><button disabled={busy || !load.data?.persistenceAvailable} onClick={() => open()}>新增访客</button></div>
    {load.error !== undefined && <ErrorNotice error={load.error} retry={load.reload} />}
    {error !== undefined && !draft && <ErrorNotice error={error} retry={load.reload} />}
    {notice && !draft && <div className="notice" role="status">{notice}</div>}
    {load.data && !load.data.persistenceAvailable && <div className="notice warning" role="status">当前数据库尚未启用访客表，需要管理员核对目标、备份并授权迁移后才能创建访客；服务不会自动升级正式库。</div>}
    <div className="guest-summary" aria-label="访客数量"><span>全部访客 <strong>{items.length}</strong></span><span>有效中 <strong>{items.filter(active).length}</strong></span><span>已过期 <strong>{items.filter(guest => !active(guest)).length}</strong></span></div>
    <div className="management-toolbar guest-toolbar"><div className="management-actions" role="group" aria-label="访客状态筛选">{[["all", "全部"], ["active", "有效中"], ["expired", "已过期"]].map(([value, title]) => <button key={value} className="secondary" aria-pressed={filter === value} onClick={() => setFilter(value!)}>{title}</button>)}</div><label>搜索访客名称<input type="search" maxLength={40} value={search} onChange={event => setSearch(event.target.value)} placeholder="输入访客名称" /></label><button className="secondary" disabled={busy || load.busy} onClick={load.reload}>刷新列表</button></div>
    {load.busy && !load.data ? <Loading /> : <TableContainer label="访客列表"><table className="management-table guest-table"><thead><tr><th scope="col">访客名称</th><th scope="col">页面与操作权限</th><th scope="col">到期时间</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead><tbody>{filtered.map(guest => <tr key={guest.id} data-guest-id={guest.id}><td><strong>{guest.name}</strong><small>创建于 {date(guest.createdAt)}</small></td><td><div className="guest-permission-tags">{guest.permissions.map(permission => <span className="management-tag" key={permission}>{GUEST_PERMISSION_LABELS[permission]}</span>)}</div></td><td><time dateTime={guest.expiresAt}>{date(guest.expiresAt)}</time><small>{timezone}</small></td><td><span className={`management-state ${active(guest) ? "" : "guest-expired"}`}>{active(guest) ? "有效中" : "已过期"}</span>{guest.revokedAt && <small>管理员提前失效</small>}</td><td><div className="management-actions"><button className="secondary" disabled={busy || !active(guest)} onClick={() => open(guest)}>编辑</button><button className="secondary" disabled={busy || !active(guest)} onClick={() => void action(guest, "reset")}>重置密码</button><button className="secondary guest-danger" disabled={busy || !active(guest)} onClick={() => void action(guest, "revoke")}>提前失效</button></div></td></tr>)}{!filtered.length && <tr><td colSpan={5} className="guest-empty">{search || filter !== "all" ? "没有符合条件的访客" : "还没有访客，点击“新增访客”生成临时密码。"}</td></tr>}</tbody></table></TableContainer>}
    {draft && <Modal title={draft.id ? "编辑访客" : "新增访客"} description="名称用于区分访客，不是登录账号。临时密码由服务端安全生成，不在列表回显。" busy={busy} onClose={() => setDraft(undefined)} className="guest-editor" footer={<><button type="button" className="secondary" disabled={busy} onClick={() => setDraft(undefined)}>取消</button><button type="submit" form="guest-editor-form" disabled={busy}>{busy ? "正在保存…" : draft.id ? "保存访客" : "创建并生成临时密码"}</button></>}>
      <form id="guest-editor-form" className="management-form guest-form" onSubmit={event => { event.preventDefault(); void save(); }}><label className="management-field">访客名称<input required maxLength={40} value={draft.name} disabled={busy} onChange={event => setDraft({ ...draft, name: event.target.value })} placeholder="例如：周末观影" /></label><div className="guest-time-fields"><label className="management-field">有效期快捷选项<select value="" disabled={busy} onChange={event => { if (event.target.value) setDraft({ ...draft, expiresAt: localTime(Date.now() + clockOffset.current + Number(event.target.value) * 3_600_000) }); }}><option value="">选择有效期</option><option value="1">1 小时后</option><option value="24">24 小时后</option><option value="168">7 天后</option></select></label><label className="management-field">到期时间<input type="datetime-local" required value={draft.expiresAt} disabled={busy} onChange={event => setDraft({ ...draft, expiresAt: event.target.value })} /><small>当前浏览器时区：{timezone}；最终以服务端校验为准。</small></label></div>
        <fieldset className="guest-permissions" disabled={busy}><legend>可访问页面</legend><div className="guest-permission-grid">{GUEST_PERMISSIONS.filter(permission => pages.includes(permission)).map(permission => <label key={permission}><input type="checkbox" checked={draft.permissions.includes(permission)} onChange={event => setDraft({ ...draft, permissions: event.target.checked ? [...draft.permissions, permission] : draft.permissions.filter(value => value !== permission) })} /><span>{GUEST_PERMISSION_LABELS[permission]}<small>{permissionHint[permission]}</small></span></label>)}</div></fieldset>
        <fieldset className="guest-permissions" disabled={busy}><legend>额外视频操作（默认不授予）</legend><div className="guest-permission-grid">{GUEST_PERMISSIONS.filter(permission => !pages.includes(permission)).map(permission => <label key={permission}><input type="checkbox" checked={draft.permissions.includes(permission)} onChange={event => setDraft({ ...draft, permissions: event.target.checked ? [...draft.permissions, permission] : draft.permissions.filter(value => value !== permission) })} /><span>{GUEST_PERMISSION_LABELS[permission]}<small>{permissionHint[permission]}</small></span></label>)}</div></fieldset>
        <div className="notice">系统设置、账户安全、访客管理和全站默认外观始终仅管理员可用。上传内容进入共享视频库；任务列表仅显示访客自己的任务。失效凭证不能恢复，请新增访客。</div>
        {notice && <div className="notice" role="status">{notice}</div>}{error !== undefined && <ErrorNotice error={error} />}{error instanceof ApiError && error.code === "GUEST_VERSION_CONFLICT" && <button type="button" className="secondary" disabled={busy} onClick={() => void refreshVersion()}>使用最新版本重试</button>}
      </form>
    </Modal>}
    {delivery && <Modal title="临时密码仅展示一次" description="关闭后无法再次查看此密码。请先复制并私下交付；遗失后需重置，重置会撤销全部旧会话。" onClose={() => { setDelivery(undefined); setCopyNotice(""); }} className="guest-delivery" footer={<><button type="button" className="secondary" onClick={() => void copyDelivery()}>复制登录信息</button><button type="button" onClick={() => { setDelivery(undefined); setCopyNotice(""); }}>已保存，关闭</button></>}><div className="stack"><label>访客登录入口<input readOnly value={`${window.location.origin}/guest/login`} /></label><label>临时密码<input className="guest-password" readOnly autoComplete="off" value={delivery.password} /></label><p>访客：<strong>{delivery.guest.name}</strong><br />到期：{date(delivery.guest.expiresAt)}（{timezone}）</p><label>可手动复制的登录信息<textarea aria-label="可手动复制的登录信息" readOnly rows={6} value={`访客登录：${window.location.origin}/guest/login\n访客名称：${delivery.guest.name}\n临时密码：${delivery.password}\n到期时间：${date(delivery.guest.expiresAt)}（${timezone}）`} /></label>{copyNotice && <div className="notice" role="status">{copyNotice}</div>}</div></Modal>}
  </>;
}
