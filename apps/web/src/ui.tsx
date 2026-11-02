import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ApiError } from "./api/client";
import { SatelliteIllustration } from "./space-console";

export function ErrorNotice({ error, retry }: { error: unknown; retry?: () => void }) {
  const message = error instanceof Error ? error.message : "暂时无法加载内容";
  return <div className="notice error" role="alert"><strong>{message}</strong>{error instanceof ApiError && error.requestId && <small>请求编号：{error.requestId}</small>}{retry && <button className="secondary" onClick={retry}>重新加载</button>}</div>;
}
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><SatelliteIllustration /><h2>{title}</h2>{children && <p>{children}</p>}</div>;
}
export function Loading() { return <div className="loading" role="status"><span className="spinner" />正在加载…</div>; }
export function TableContainer({ label, children }: { label: string; children: ReactNode }) {
  return <div className="management-table-scroll" role="region" aria-label={label} tabIndex={0}>{children}</div>;
}
export function Modal({ title, description, onClose, busy = false, children, footer, className = "", spaceSettings = false }: {
  title: string; description?: string; onClose: () => void; busy?: boolean; children: ReactNode; footer?: ReactNode; className?: string; spaceSettings?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null); const titleId = useId(); const descriptionId = useId();
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    node.showModal();
    node.querySelector<HTMLElement>("[autofocus], input:not(:disabled):not([readonly]):not([type=hidden]), select:not(:disabled), textarea:not(:disabled):not([readonly])")?.focus({ preventScroll: true });
    return () => {
      node.close();
      queueMicrotask(() => { if (!node.open && opener?.isConnected) opener.focus(); });
    };
  }, []);
  return <dialog ref={dialog} data-space-settings={spaceSettings ? "true" : undefined} className={`management-modal ${className}`} aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined} aria-modal="true" aria-busy={busy} tabIndex={-1} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onKeyDown={event => {
    if (event.key !== "Tab") return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href], [tabindex]")].filter(node => !node.matches(":disabled, [tabindex='-1']") && node.getClientRects().length > 0);
    const first = controls[0]; const last = controls.at(-1);
    if (!first) { event.preventDefault(); event.currentTarget.focus(); }
    else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }}>
    <header className="management-modal-header"><div><h2 id={titleId}>{title}</h2>{description && <p id={descriptionId}>{description}</p>}</div><button type="button" className="secondary management-modal-close" aria-label="关闭弹窗" disabled={busy} onClick={onClose}>×</button></header>
    <div className="management-modal-body">{children}</div>
    {footer && <footer className="management-modal-footer">{footer}</footer>}
  </dialog>;
}
export function useLoad<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(true);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let alive = true;
    setBusy(true); setError(undefined);
    loader().then(value => { if (alive) setData(value); }).catch(err => { if (alive) setError(err); }).finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
    // 调用方以依赖数组明确请求生命周期；过期响应不更新页面。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version]);
  return { data, error, busy, reload: () => setVersion(v => v + 1) };
}
export function Icon({ name }: { name: "library" | "upload" | "folder" | "shield" | "play" | "filter" | "search" | "chevron" | "cloud-upload" | "check" | "sparkles" | "home" | "history" | "star" | "settings" }) {
  const paths = {
    library: "M4 5h16v14H4z M9 5v14 M4 10h5",
    upload: "M12 16V4 M7 9l5-5 5 5 M4 16v4h16v-4",
    folder: "M3 7V5h6l2 2h10v13H3z",
    shield: "M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6z M8 12l3 3 5-6",
    play: "M8 4l12 8-12 8z",
    filter: "M4 6h16 M7 12h10 M10 18h4",
    search: "M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
    chevron: "M6 9l6 6 6-6",
    "cloud-upload": "M16 16l-4-4-4 4 M12 12v9 M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3",
    check: "M20 6L9 17l-5-5",
    sparkles: "M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z",
    home: "M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M9 22V12h6v10",
    history: "M12 8v4l3 3 M3.05 11a9 9 0 1 1 .5 4m-.5 5v-5h5",
    star: "M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z",
    settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
  };
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
export const bytes = (value: number) => { const unit = value >= 1073741824 ? "GiB" : value >= 1048576 ? "MiB" : value >= 1024 ? "KiB" : "B"; const divisor = unit === "GiB" ? 1073741824 : unit === "MiB" ? 1048576 : unit === "KiB" ? 1024 : 1; return `${(value / divisor).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} ${unit}`; };
export const duration = (value: number | null) => {
  if (value === null || !Number.isFinite(value) || value < 0) return "时长待采集";
  const seconds = Math.floor(value);
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
    : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
export const videoDuration = (value: number | null) => value !== null && Number.isFinite(value) && value > 0 && value <= 31 * 24 * 3600 ? duration(value) : "时长待采集";
export const date = (value: string) => new Date(value).toLocaleString("zh-CN", { hour12: false });
export const periodDate = (value: string, timezone: string) => new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "medium", timeZone: timezone }).format(new Date(value));
export const videoStatus = { ready: "可播放", processing: "处理中", unsupported: "格式不支持", failed: "处理失败" };
