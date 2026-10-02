import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ApiError } from "./api/client";

export function ErrorNotice({ error, retry }: { error: unknown; retry?: () => void }) {
  const message = error instanceof Error ? error.message : "暂时无法加载内容";
  return <div className="notice error" role="alert"><strong>{message}</strong>{error instanceof ApiError && error.requestId && <small>请求编号：{error.requestId}</small>}{retry && <button className="secondary" onClick={retry}>重新加载</button>}</div>;
}
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><Icon name="library" /><h2>{title}</h2>{children && <p>{children}</p>}</div>;
}
export function Loading() { return <div className="loading" role="status"><span className="spinner" />正在加载…</div>; }
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
export function Icon({ name }: { name: "library" | "upload" | "folder" | "shield" | "play" }) {
  const paths = { library: "M4 5h16v14H4z M9 5v14 M4 10h5", upload: "M12 16V4 M7 9l5-5 5 5 M4 16v4h16v-4", folder: "M3 7V5h6l2 2h10v13H3z", shield: "M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6z M8 12l3 3 5-6", play: "M8 4l12 8-12 8z" };
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
export const bytes = (value: number) => { const unit = value >= 1073741824 ? "GiB" : value >= 1048576 ? "MiB" : value >= 1024 ? "KiB" : "B"; const divisor = unit === "GiB" ? 1073741824 : unit === "MiB" ? 1048576 : unit === "KiB" ? 1024 : 1; return `${(value / divisor).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} ${unit}`; };
export const duration = (value: number | null) => value === null ? "时长待采集" : `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;
export const date = (value: string) => new Date(value).toLocaleString("zh-CN", { hour12: false });
export const periodDate = (value: string, timezone: string) => new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "medium", timeZone: timezone }).format(new Date(value));
export const videoStatus = { ready: "可播放", processing: "处理中", unsupported: "格式不支持", failed: "处理失败" };
