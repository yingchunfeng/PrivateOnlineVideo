import { useEffect, useRef, useState } from "react";
import type { SiteSettings } from "@online-video/shared";
import { api } from "../api";
import { useAuth } from "../auth";
import { ApiError } from "../api/client";
import { notifySiteSettingsChanged } from "../site-settings-sync";
import { useTheme } from "../theme-context";
import { useSpaceMotion } from "../space-motion";
import { useSpaceMeteors } from "../space-meteors";
import { SpaceMotionSettings } from "../space-motion-settings";
import { ErrorNotice, Modal, TableContainer, useLoad } from "../ui";
import type { Theme } from "../theme";
import "./page-management.css";

const themeName = (value: Theme) => value === "dark" ? "深色" : "浅色";
export function PageManagementPage() {
  const auth = useAuth(); const isAdmin = !auth.session?.guest;
  const appearance = useTheme(); const motion = useSpaceMotion(); const meteors = useSpaceMeteors();
  const load = useLoad(() => isAdmin ? api.request<SiteSettings>("/api/settings/site") : Promise.resolve(undefined), [isAdmin]);
  const [site, setSite] = useState<SiteSettings>();
  const [editor, setEditor] = useState<{ kind: "personal" | "default"; theme: Theme; version: number }>();
  const [spaceOpen, setSpaceOpen] = useState(false); const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(); const [notice, setNotice] = useState("");
  const saving = useRef(false);
  useEffect(() => { setSite(isAdmin ? load.data : undefined); }, [load.data, isAdmin]);
  const open = (kind: "personal" | "default") => { setError(undefined); setNotice(""); setEditor({ kind, theme: kind === "personal" ? appearance.theme : site?.defaultTheme ?? "light", version: site?.version ?? 0 }); };
  const save = async () => {
    if (!editor || saving.current) return;
    if (editor.kind === "personal") { appearance.selectTheme(editor.theme); setEditor(undefined); setNotice("当前浏览器外观已保存；下次成功登录时重新应用站点默认值。"); return; }
    saving.current = true; setBusy(true); setError(undefined);
    try {
      const next = await api.request<SiteSettings>("/api/settings/site", { method: "PATCH", body: { version: editor.version, defaultTheme: editor.theme } });
      setSite(next); setEditor(undefined); notifySiteSettingsChanged(); setNotice("站点默认外观已保存，新的登录会话将应用此值；不会改动当前会话的个人外观。");
    } catch (failure) { setError(failure); if (failure instanceof ApiError && failure.code === "CONFIG_VERSION_CONFLICT") load.reload(); }
    finally { saving.current = false; setBusy(false); }
  };
  const refreshVersion = async () => {
    if (!editor || saving.current) return;
    saving.current = true; setBusy(true);
    try { const latest = await api.request<SiteSettings>("/api/settings/site"); setSite(latest); setEditor({ ...editor, version: latest.version }); setError(undefined); }
    catch (failure) { setError(failure); }
    finally { saving.current = false; setBusy(false); }
  };
  return <>
    <div className="page-head"><div><h1>页面管理</h1></div></div>
    {notice && <div className="notice" role="status">{notice}</div>}
    {isAdmin && load.error !== undefined && <ErrorNotice error={load.error} retry={load.reload} />}
    {isAdmin && site && !site.persistenceAvailable && <div className="notice warning" role="status">站点配置尚未启用持久化，需要管理员核对数据库目标并授权迁移后才能保存全站默认值；当前浏览器的外观和星空仍可调整。</div>}
    <TableContainer label="页面配置列表"><table className="management-table page-settings-table"><thead><tr><th scope="col">配置名称</th><th scope="col">当前值</th><th scope="col">操作</th></tr></thead><tbody>
      <tr><td><strong>当前浏览器外观</strong></td><td>{themeName(appearance.theme)}</td><td><button className="secondary" onClick={() => open("personal")}>编辑个人外观</button></td></tr>
      {isAdmin && <tr><td><strong>默认登录外观</strong></td><td>{site ? themeName(site.defaultTheme) : load.busy ? "正在读取…" : "读取失败"}</td><td><button className="secondary" disabled={!site?.persistenceAvailable} onClick={() => open("default")}>编辑默认外观</button></td></tr>}
      <tr><td><strong>动态星空</strong></td><td>{motion.reduced ? "系统静态" : motion.preferred ? "开启" : "关闭"}<small>普通流星 {meteors.settings.normal.enabled ? "开启" : "关闭"} · 流星雨 {meteors.settings.shower.enabled ? "开启" : "关闭"}</small></td><td><button className="secondary" onClick={() => setSpaceOpen(true)}>编辑动态星空</button></td></tr>
    </tbody></table></TableContainer>
    {editor && <Modal title={editor.kind === "personal" ? "编辑个人外观" : "编辑默认登录外观"} description={editor.kind === "personal" ? "仅影响此浏览器；取消不会改变当前外观。" : "成功保存后，对下一次成功登录生效；不会立即切换当前页面。"} onClose={() => setEditor(undefined)} busy={busy} footer={<><button type="button" className="secondary" disabled={busy} onClick={() => setEditor(undefined)}>取消</button><button type="submit" form="page-theme-editor" disabled={busy}>{busy ? "正在保存…" : "保存"}</button></>}><form id="page-theme-editor" className="management-form" onSubmit={event => { event.preventDefault(); void save(); }}><fieldset className="page-theme-options" disabled={busy}><legend>界面外观</legend>{(["light", "dark"] as const).map(value => <label key={value}><input type="radio" name="page-theme" value={value} checked={editor.theme === value} onChange={() => setEditor({ ...editor, theme: value })} />{themeName(value)}</label>)}</fieldset>{error !== undefined && <ErrorNotice error={error} />}{error instanceof ApiError && error.code === "CONFIG_VERSION_CONFLICT" && <div className="notice warning"><p>其他页面已修改配置。选择内容已保留，请核对后读取最新版本，再保存。</p><button type="button" className="secondary" disabled={busy} onClick={() => void refreshVersion()}>使用最新版本重试</button></div>}</form></Modal>}
    {spaceOpen && <SpaceMotionSettings enabled={motion.enabled} reduced={motion.reduced} preferred={motion.preferred} onSaveEnabled={motion.setPreferred} onClose={() => setSpaceOpen(false)} />}
  </>;
}
