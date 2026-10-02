import { useEffect, useRef, useState } from "react";
import type { ApplicationUsage, PlaybackSession, VideoDetail, WatchProgress } from "@online-video/shared";
import { api } from "./api";
import { ApiError, isSiteApiPath } from "./api/client";
import { duration, ErrorNotice } from "./ui";
import { presentUsage } from "./usage";

type PlayerState = "idle" | "loading" | "ready" | "playing" | "paused" | "buffering" | "unsupported" | "limited" | "expired" | "failed";
const playerLabels: Record<PlayerState, string> = { idle: "点击开始播放", loading: "正在准备播放", ready: "视频已就绪", playing: "正在播放", paused: "已暂停", buffering: "正在缓冲，请保持网络连接", unsupported: "浏览器不支持此视频格式", limited: "播放受到限额或并发限制", expired: "播放会话已失效，请重新登录", failed: "无法播放，请查看错误提示" };

export function VideoPlayer({ video }: { video: VideoDetail }) {
  const element = useRef<HTMLVideoElement>(null);
  const sessionRef = useRef<PlaybackSession | undefined>(undefined);
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  const mounted = useRef(true);
  const [session, setSession] = useState<PlaybackSession>();
  const [state, setState] = useState<PlayerState>("idle");
  const [error, setError] = useState<unknown>();
  const [saveError, setSaveError] = useState<unknown>();
  const [position, setPosition] = useState(video.lastPositionSeconds);
  const [restored, setRestored] = useState(false);
  const [ended, setEnded] = useState(false);
  const positionRef = useRef(video.lastPositionSeconds);
  const appliedRef = useRef(false);
  const starting = useRef(false);
  const startController = useRef<AbortController | undefined>(undefined);
  const closing = useRef<Promise<void> | undefined>(undefined);
  const failed = useRef(false);
  const savedAt = useRef(0);

  const report = (err: unknown) => {
    if (!mounted.current) return;
    failed.current = true; element.current?.pause(); setError(err);
    if (err instanceof ApiError && ["AUTH_REQUIRED", "SESSION_EXPIRED", "CSRF_REJECTED"].includes(err.code)) setState("expired");
    else if (err instanceof ApiError && ["TRANSFER_LIMIT_EXCEEDED", "PLAYBACK_CONCURRENCY_LIMIT", "RATE_LIMITED", "SERVICE_NOT_CONFIGURED"].includes(err.code)) setState("limited");
    else if (err instanceof ApiError && err.code === "UNSUPPORTED_MEDIA_TYPE") setState("unsupported");
    else setState("failed");
  };
  const save = (keepalive = false) => {
    const current = element.current?.currentTime ?? positionRef.current;
    positionRef.current = current;
    if (!appliedRef.current || !Number.isFinite(current) || current < 0) return;
    const positionSeconds = video.durationSeconds === null ? current : Math.min(current, video.durationSeconds);
    saving.current = saving.current.catch(() => {}).then(() => api.request<WatchProgress>(`/api/videos/${encodeURIComponent(video.id)}/progress`, { method: "PUT", body: { positionSeconds }, keepalive })).then(() => { if (mounted.current) setSaveError(undefined); }).catch(err => { if (mounted.current) setSaveError(err); });
  };
  const close = async (keepalive = false) => {
    if (closing.current) { await closing.current; return; }
    const active = sessionRef.current;
    if (!active) return;
    closing.current = api.request<{ success: true }>(`/api/playback-sessions/${encodeURIComponent(active.id)}/close`, { method: "POST", keepalive }).then(() => { if (sessionRef.current?.id === active.id) sessionRef.current = undefined; });
    try { await closing.current; } finally { closing.current = undefined; }
  };
  const start = async () => {
    if (starting.current) return;
    starting.current = true; failed.current = false; setError(undefined); setState("loading"); setRestored(false); setEnded(false); appliedRef.current = false;
    const controller = new AbortController(); startController.current = controller;
    try {
      await close();
      const progress = await api.request<WatchProgress>(`/api/videos/${encodeURIComponent(video.id)}/progress`, { signal: controller.signal });
      if (progress.videoId !== video.id || !Number.isFinite(progress.positionSeconds) || progress.positionSeconds < 0) throw new ApiError("INVALID_RESPONSE", "观看记录无效，不能恢复播放");
      const created = await api.request<PlaybackSession>(`/api/videos/${encodeURIComponent(video.id)}/playback-sessions`, { method: "POST", signal: controller.signal });
      if (!mounted.current) { await api.request(`/api/playback-sessions/${encodeURIComponent(created.id)}/close`, { method: "POST" }); return; }
      sessionRef.current = created;
      if (created.mode !== "proxy" || created.videoId !== video.id || !isSiteApiPath(created.sourceUrl) || new URL(created.sourceUrl, window.location.origin).pathname !== `/api/videos/${encodeURIComponent(video.id)}/stream`) throw new ApiError("INVALID_RESPONSE", "播放入口不是受保护的站内 A 模式地址");
      const restartFromZero = video.durationSeconds !== null && progress.positionSeconds >= video.durationSeconds - .5;
      positionRef.current = restartFromZero ? 0 : progress.positionSeconds; setPosition(positionRef.current); setSession(created);
    } catch (err) { if (!(err instanceof DOMException && err.name === "AbortError")) report(err); await close().catch(() => {}); } finally { starting.current = false; }
  };
  useEffect(() => {
    mounted.current = true;
    const onHidden = () => { if (document.visibilityState === "hidden") save(true); };
    const onPageHide = () => { save(true); void close(true).catch(() => {}); };
    document.addEventListener("visibilitychange", onHidden); window.addEventListener("pagehide", onPageHide);
    return () => { mounted.current = false; startController.current?.abort(); save(true); void close(true).catch(() => {}); document.removeEventListener("visibilitychange", onHidden); window.removeEventListener("pagehide", onPageHide); };
  }, []);
  useEffect(() => {
    if (!session) return;
    const heartbeat = async () => {
      if (!sessionRef.current || failed.current) return;
      try {
        const active = await api.request<PlaybackSession>(`/api/playback-sessions/${encodeURIComponent(session.id)}/heartbeat`, { method: "POST" });
        if (Date.parse(active.expiresAt) <= Date.now()) throw new ApiError("SESSION_EXPIRED", "播放会话已过期");
        sessionRef.current = active;
      } catch (err) { report(err); void close().catch(() => {}); }
    };
    const timer = setInterval(() => void heartbeat(), 20000);
    return () => clearInterval(timer);
  }, [session]);
  const mediaError = async () => {
    const active = sessionRef.current;
    try {
      if (active) await api.request<PlaybackSession>(`/api/playback-sessions/${encodeURIComponent(active.id)}/heartbeat`, { method: "POST" });
      const usage = presentUsage(await api.request<ApplicationUsage>("/api/settings/usage"));
      if (usage.kind === "unconfigured") throw new ApiError("SERVICE_NOT_CONFIGURED", "传输限额尚未配置，请检查服务端安全配置");
      if (usage.kind === "limited" && usage.reached) throw new ApiError("TRANSFER_LIMIT_EXCEEDED", "传输流量达到上限，已停止播放");
      const code = element.current?.error?.code;
      report(new ApiError(code === 4 ? "UNSUPPORTED_MEDIA_TYPE" : "STORAGE_UNAVAILABLE", code === 4 ? "浏览器无法解码此原片，请使用离线兼容副本" : "视频流已中断；可能为网络、存储或传输限额，请查看应用用量后手动重试"));
    } catch (err) { report(err); }
    await close().catch(() => {});
  };
  const terminal = ["failed", "expired", "limited", "unsupported"].includes(state);
  return <section className="player-section section-space" aria-label="视频播放器"><div className="player-frame" style={{ aspectRatio: video.width && video.height ? `${video.width} / ${video.height}` : "16 / 9" }}>{session ? <video ref={element} src={session.sourceUrl} controls playsInline preload="metadata" aria-label={video.title} onLoadedMetadata={() => {
    const node = element.current; if (!node || appliedRef.current) return;
    const max = Number.isFinite(node.duration) ? node.duration : (video.durationSeconds ?? positionRef.current);
    node.currentTime = Math.min(positionRef.current, max); appliedRef.current = true;
    setRestored(positionRef.current > 0); setState("ready");
  }} onCanPlay={() => { if (!terminal) setState(element.current?.paused ? "ready" : "playing"); }} onPlay={() => setState("playing")} onPause={() => { if (!terminal) setState("paused"); save(); }} onWaiting={() => { if (!terminal) setState("buffering"); }} onTimeUpdate={() => {
    positionRef.current = element.current?.currentTime ?? 0; setPosition(positionRef.current);
    if (Date.now() - savedAt.current > 10000) { savedAt.current = Date.now(); save(); }
  }} onSeeked={() => save()} onEnded={() => { positionRef.current = video.durationSeconds ?? element.current?.currentTime ?? 0; save(); void close().catch(report); setEnded(true); setSession(undefined); setState("idle"); }} onError={() => void mediaError()} /> : <div className="player-placeholder"><p>{playerLabels[state]}</p><button disabled={state === "loading"} onClick={() => void start()}>{state === "loading" ? "正在准备…" : (ended || (video.durationSeconds !== null && video.lastPositionSeconds >= video.durationSeconds - .5)) ? "重新播放" : video.lastPositionSeconds > 0 ? `从 ${duration(video.lastPositionSeconds)} 继续` : "开始播放"}</button></div>}</div><div className="player-status" role="status"><span>{playerLabels[state]}</span><span>{duration(position)} / {duration(video.durationSeconds)}</span></div>{restored && <div className="notice" role="status">已恢复至 {duration(position)}。<button className="secondary" onClick={() => { if (element.current) { element.current.currentTime = 0; positionRef.current = 0; setPosition(0); setRestored(false); save(); } }}>从头开始</button></div>}{error !== undefined && <ErrorNotice error={error} />}{terminal && state !== "expired" && <button className="secondary" onClick={() => { setSession(undefined); void start(); }}>手动重新准备播放</button>}{saveError !== undefined && <ErrorNotice error={saveError} retry={() => save()} />}<p className="muted player-note">A 模式 · 原片通过站内 API 播放。3Mbps 带宽下，高码率视频可能缓冲；网站保留原片画质。</p></section>;
}
