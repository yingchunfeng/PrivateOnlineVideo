import { useEffect, useRef, useState } from "react";
import type { VideoDetail, WatchProgress } from "@online-video/shared";
import { api } from "./api";
import { publicMediaUrl } from "./library-data";
import { duration, ErrorNotice } from "./ui";

export function PublicVideoPlayer({ video }: { video: VideoDetail }) {
  const element = useRef<HTMLVideoElement>(null); const alive = useRef(true); const applied = useRef(false); const lastSaved = useRef(0);
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  const [status, setStatus] = useState("点击播放器开始播放"); const [position, setPosition] = useState(video.lastPositionSeconds); const [restored, setRestored] = useState(false);
  const [error, setError] = useState<unknown>(); const [saveError, setSaveError] = useState<unknown>(); const [mediaDuration, setMediaDuration] = useState(video.durationSeconds);
  const save = (keepalive = false) => {
    const current = element.current?.currentTime;
    if (!applied.current || current === undefined || !Number.isFinite(current) || current < 0) return;
    const positionSeconds = video.durationSeconds === null ? current : Math.min(current, video.durationSeconds);
    lastSaved.current = Date.now();
    saving.current = saving.current.catch(() => {}).then(() => api.request<WatchProgress>(`/api/videos/${encodeURIComponent(video.id)}/progress`, { method: "PUT", body: { positionSeconds }, keepalive })).then(() => { if (alive.current) setSaveError(undefined); }).catch(err => { if (alive.current) setSaveError(err); });
  };
  useEffect(() => {
    alive.current = true;
    const hidden = () => { if (document.visibilityState === "hidden") save(true); }; const pagehide = () => save(true);
    document.addEventListener("visibilitychange", hidden); window.addEventListener("pagehide", pagehide);
    return () => { save(true); alive.current = false; document.removeEventListener("visibilitychange", hidden); window.removeEventListener("pagehide", pagehide); };
  }, [video.id]);
  if (!video.publicUrl) return <div className="notice sci-notice">此记录尚无可用公共地址，请核对已登记的对象路径。</div>;
  let source: string;
  try { source = publicMediaUrl(video.publicUrl); } catch (err) { return <ErrorNotice error={err} />; }
  let poster: string | undefined;
  try { if (video.coverUrl) poster = publicMediaUrl(video.coverUrl); } catch { /* 封面无效不阻止公共视频播放。 */ }
  return <section className="player-section section-space" aria-label="视频播放器"><div className="player-frame" style={{ aspectRatio: video.width && video.height ? `${video.width} / ${video.height}` : "16 / 9" }}><video ref={element} src={source} poster={poster} controls playsInline preload="metadata" aria-label={video.title} onLoadedMetadata={() => {
    const node = element.current; if (!node || applied.current) return;
    const total = Number.isFinite(node.duration) ? node.duration : video.durationSeconds;
    if (total !== null) setMediaDuration(total);
    const resume = total !== null && video.lastPositionSeconds >= total - .5 ? 0 : video.lastPositionSeconds;
    node.currentTime = total === null ? resume : Math.min(resume, total); applied.current = true; setPosition(node.currentTime); setRestored(resume > 0); setStatus("视频已就绪");
  }} onPlay={() => { setError(undefined); setStatus("正在播放"); }} onPause={() => { if (!element.current?.error) setStatus("已暂停"); save(); }} onWaiting={() => setStatus("正在缓冲，请保持网络连接")} onCanPlay={() => setStatus(element.current?.paused ? "视频已就绪" : "正在播放")} onTimeUpdate={() => { if (!applied.current) return; setPosition(element.current?.currentTime ?? 0); if (Date.now() - lastSaved.current > 10000) save(); }} onSeeked={() => save()} onEnded={() => { setStatus("播放结束"); save(); }} onError={() => {
    const code = element.current?.error?.code;
    const message = code === 3 || code === 4 ? "当前浏览器无法播放此视频格式或编码，请打开原地址尝试。" : "视频加载失败，请检查网络或该对象的公共读取权限，并打开原地址核对。";
    setStatus("无法播放"); setError(new Error(message));
  }} /></div><div className="player-status" role="status"><span>{status}</span><span>{duration(position)} / {duration(mediaDuration)}</span></div>{restored && <div className="notice" role="status">已恢复至 {duration(position)}。<button className="secondary" onClick={() => { if (element.current) { element.current.currentTime = 0; setPosition(0); setRestored(false); save(); } }}>从头开始</button></div>}{error !== undefined && <><ErrorNotice error={error} /><div className="actions"><button className="secondary" onClick={() => { setError(undefined); setStatus("正在重新加载"); applied.current = false; element.current?.load(); }}>重新加载视频</button><a className="button secondary" href={source} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">打开原地址</a></div></>}{saveError !== undefined && <ErrorNotice error={saveError} retry={() => save()} />}<p className="muted player-note">视频由 OSS 公共地址直接播放，格式兼容性以当前浏览器为准。</p></section>;
}
