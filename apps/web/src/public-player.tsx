import { useEffect, useRef, useState } from "react";
import type { VideoDetail, WatchProgress } from "@online-video/shared";
import { api } from "./api";
import { publicMediaUrl } from "./library-data";
import type { PublicMediaPolicy } from "./library-data";
import { duration, videoDuration, ErrorNotice } from "./ui";
import { isVideoDuration, saveMediaDuration } from "./media-duration";

export function PublicVideoPlayer({ video, library, onDurationSaved, canSaveDuration = true }: { video: VideoDetail; library: PublicMediaPolicy; onDurationSaved?: (video: VideoDetail) => void; canSaveDuration?: boolean }) {
  const element = useRef<HTMLVideoElement>(null); const alive = useRef(true); const applied = useRef(false); const lastSaved = useRef(0);
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  const [status, setStatus] = useState("点击播放器开始播放"); const [position, setPosition] = useState(video.lastPositionSeconds); const [restored, setRestored] = useState(false);
  const [error, setError] = useState<unknown>(); const [saveError, setSaveError] = useState<unknown>(); const [mediaDuration, setMediaDuration] = useState(video.durationSeconds);
  const [durationError, setDurationError] = useState<unknown>(); const [durationStatus, setDurationStatus] = useState(isVideoDuration(video.durationSeconds) ? "时长已保存" : "正在读取视频总时长…");
  const [durationRetry, setDurationRetry] = useState(0); const durationSaved = useRef(isVideoDuration(video.durationSeconds)); const durationWorking = useRef(false);
  const metadataAbort = useRef<AbortController | undefined>(undefined);
  const saveTotal = async (seconds: number) => {
    if (!canSaveDuration || durationSaved.current || durationWorking.current) return;
    if (!isVideoDuration(seconds)) { setDurationError(new Error("未能读取有效总时长，请重试或换用支持此格式的浏览器")); return; }
    durationWorking.current = true; setDurationError(undefined); setDurationStatus("正在保存视频总时长…");
    try { const saved = await saveMediaDuration(api, video, seconds, metadataAbort.current?.signal); if (alive.current) { durationSaved.current = true; setMediaDuration(saved.durationSeconds); setDurationStatus("时长已保存，刷新后仍保留"); onDurationSaved?.(saved); } }
    catch (err) { if (alive.current && !(err instanceof DOMException && err.name === "AbortError")) setDurationError(err); }
    finally { durationWorking.current = false; }
  };
  useEffect(() => {
    if (!canSaveDuration) { setDurationError(undefined); setDurationStatus("当前仅查看时长，无视频编辑权限"); metadataAbort.current?.abort(); return; }
    const controller = new AbortController(); metadataAbort.current = controller;
    const timer = setTimeout(() => { if (!durationSaved.current && !durationWorking.current) setDurationError(new Error("时长采集超时，原视频不受影响，请重试")); }, 8000);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [video.id, durationRetry, canSaveDuration]);
  const save = (keepalive = false) => {
    const current = element.current?.currentTime;
    if (!applied.current || current === undefined || !Number.isFinite(current) || current < 0) return;
    const positionSeconds = isVideoDuration(mediaDuration) ? Math.min(current, mediaDuration) : current;
    lastSaved.current = Date.now();
    saving.current = saving.current.catch(() => {}).then(() => api.request<WatchProgress>(`/api/videos/${encodeURIComponent(video.id)}/progress`, { method: "PUT", body: { positionSeconds }, keepalive })).then(() => { if (alive.current) setSaveError(undefined); }).catch(err => { if (alive.current) setSaveError(err); });
  };
  useEffect(() => {
    alive.current = true;
    const media = element.current;
    const hidden = () => { if (document.visibilityState === "hidden") save(true); }; const pagehide = () => save(true);
    document.addEventListener("visibilitychange", hidden); window.addEventListener("pagehide", pagehide);
    return () => { save(true); alive.current = false; media?.pause(); media?.removeAttribute("src"); media?.load(); document.removeEventListener("visibilitychange", hidden); window.removeEventListener("pagehide", pagehide); };
  }, [video.id]);
  if (!video.publicUrl) return <div className="notice sci-notice">此记录尚无可用公共地址，请核对已登记的对象路径。</div>;
  let source: string;
  try { source = publicMediaUrl(video.publicUrl, library); } catch (err) { return <ErrorNotice error={err} />; }
  let poster: string | undefined;
  try { if (video.coverUrl) poster = publicMediaUrl(video.coverUrl, library); } catch { /* 封面无效不阻止公共视频播放。 */ }
  return <section className="player-section section-space" aria-label="视频播放器"><div className="player-frame" style={{ aspectRatio: video.width && video.height ? `${video.width} / ${video.height}` : "16 / 9" }}><video ref={element} src={source} poster={poster} controls playsInline preload="metadata" aria-label={video.title} onLoadedMetadata={() => {
    const node = element.current; if (!node || applied.current) return;
    const total = isVideoDuration(node.duration) ? node.duration : isVideoDuration(video.durationSeconds) ? video.durationSeconds : null;
    if (total !== null) setMediaDuration(total);
    const resume = total !== null && video.lastPositionSeconds >= total - .5 ? 0 : video.lastPositionSeconds;
    node.currentTime = total === null ? resume : Math.min(resume, total); applied.current = true; setPosition(node.currentTime); setRestored(resume > 0); setStatus("视频已就绪");
    void saveTotal(node.duration);
  }} onPlay={() => { setError(undefined); setStatus("正在播放"); }} onPause={() => { if (!element.current?.error) setStatus("已暂停"); save(); }} onWaiting={() => setStatus("正在缓冲，请保持网络连接")} onCanPlay={() => setStatus(element.current?.paused ? "视频已就绪" : "正在播放")} onTimeUpdate={() => { if (!applied.current) return; setPosition(element.current?.currentTime ?? 0); if (Date.now() - lastSaved.current > 10000) save(); }} onSeeked={() => save()} onEnded={() => { setStatus("播放结束"); save(); }} onError={() => {
    const code = element.current?.error?.code;
    const message = code === 3 || code === 4 ? "当前浏览器无法播放此视频格式或编码，请打开原地址尝试。" : "视频加载失败，请检查网络或该对象的公共读取权限，并打开原地址核对。";
    setStatus("无法播放"); setError(new Error(message));
    if (canSaveDuration && !durationSaved.current) setDurationError(new Error("时长采集失败：媒体无法加载，修复网络或格式后可重新采集"));
  }} /></div><div className="player-status" role="status"><span>{status}</span><span>{duration(position)} / {videoDuration(mediaDuration)}</span></div><div className="video-duration-feedback" aria-live="polite">{durationError !== undefined ? <><ErrorNotice error={durationError} /><button className="secondary" disabled={durationWorking.current} onClick={() => { setDurationError(undefined); setDurationStatus("正在重新采集视频总时长…"); const node = element.current; if (node && isVideoDuration(node.duration)) void saveTotal(node.duration); else { setDurationRetry(value => value + 1); applied.current = false; node?.load(); } }}>重新采集时长</button></> : <small role="status">{durationStatus}</small>}</div>{restored && <div className="notice" role="status">已恢复至 {duration(position)}。<button className="secondary" onClick={() => { if (element.current) { element.current.currentTime = 0; setPosition(0); setRestored(false); save(); } }}>从头开始</button></div>}{error !== undefined && <><ErrorNotice error={error} /><div className="actions"><button className="secondary" onClick={() => { setError(undefined); setStatus("正在重新加载"); applied.current = false; element.current?.load(); }}>重新加载视频</button><a className="button secondary" href={source} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">打开原地址</a></div></>}{saveError !== undefined && <ErrorNotice error={saveError} retry={() => save()} />}<p className="muted player-note">视频由 OSS 公共地址直接播放，格式兼容性以当前浏览器为准。缺失时长仅对当前详情视频采集；失败不会阻断播放。</p></section>;
}
