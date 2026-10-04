import { useEffect, useRef, useState } from "react";
import type { ApplicationUsage, PlaybackHeartbeat, PlaybackSession, VideoDetail, WatchProgress } from "@online-video/shared";
import { api } from "./api";
import { ApiError } from "./api/client";
import { validatePlayback } from "./media";
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
  const renewing = useRef<Promise<void> | undefined>(undefined);
  const switchingSource = useRef(false);
  const resumeAfterSource = useRef(false);
  const desiredPlaying = useRef(false);
  const mediaRecoveryAttempts = useRef(0);
  const renewalFailures = useRef(0);
  const nextRenewalRetry = useRef(0);

  const report = (err: unknown) => {
    if (!mounted.current) return;
    failed.current = true; element.current?.pause(); setError(err);
    if (err instanceof ApiError && ["AUTH_REQUIRED", "SESSION_EXPIRED", "CSRF_REJECTED"].includes(err.code)) setState("expired");
    else if (err instanceof ApiError && ["TRANSFER_LIMIT_EXCEEDED", "PLAYBACK_CONCURRENCY_LIMIT", "RATE_LIMITED", "SERVICE_NOT_CONFIGURED"].includes(err.code)) setState("limited");
    else if (err instanceof ApiError && err.code === "UNSUPPORTED_MEDIA_TYPE") setState("unsupported");
    else setState("failed");
  };
  const save = (keepalive = false) => {
    if (switchingSource.current) return;
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
      validatePlayback(created, video.id);
      mediaRecoveryAttempts.current = 0; renewalFailures.current = 0; nextRenewalRetry.current = 0; desiredPlaying.current = false; resumeAfterSource.current = false;
      const restartFromZero = video.durationSeconds !== null && progress.positionSeconds >= video.durationSeconds - .5;
      positionRef.current = restartFromZero ? 0 : progress.positionSeconds; setPosition(positionRef.current); setSession(created);
    } catch (err) { if (!(err instanceof DOMException && err.name === "AbortError")) report(err); await close().catch(() => {}); } finally { starting.current = false; }
  };
  const renewSource = async (reason: "expiry" | "background" | "error") => {
    if (renewing.current) return renewing.current;
    const active = sessionRef.current;
    if (!active || active.mode !== "oss" || failed.current) return;
    renewing.current = (async () => {
      const received = await api.request<PlaybackSession>(`/api/playback-sessions/${encodeURIComponent(active.id)}/source`, { method: "POST" });
      if (!mounted.current || sessionRef.current?.id !== active.id) return;
      // 签发/网络期间心跳可确认更晚的应用期限；源响应不能覆盖成旧期限。
      const current = sessionRef.current;
      const refreshed = validatePlayback({ ...received, expiresAt: Date.parse(current.expiresAt) > Date.parse(received.expiresAt) ? current.expiresAt : received.expiresAt }, video.id, active.id);
      if (refreshed.mode !== "oss") throw new ApiError("INVALID_RESPONSE", "续签不能改变媒体传输模式");
      const node = element.current;
      if (reason !== "error" && node && appliedRef.current && Number.isFinite(node.currentTime)) positionRef.current = node.currentTime;
      resumeAfterSource.current = reason === "error" ? desiredPlaying.current : !!node && !node.paused;
      switchingSource.current = true; appliedRef.current = false; node?.pause();
      sessionRef.current = refreshed; setSession(refreshed); setState("loading");
      renewalFailures.current = 0; nextRenewalRetry.current = 0;
    })();
    try { await renewing.current; } finally { renewing.current = undefined; }
  };
  const requestRenewal = async (reason: "expiry" | "background" | "error") => {
    try { await renewSource(reason); }
    catch (err) {
      const authFailure = err instanceof ApiError && ["AUTH_REQUIRED", "SESSION_EXPIRED", "CSRF_REJECTED"].includes(err.code);
      const active = sessionRef.current;
      const playbackExpired = err instanceof ApiError && err.code === "FORBIDDEN" && !!active && Date.parse(active.expiresAt) <= Date.now();
      renewalFailures.current++; nextRenewalRetry.current = Date.now() + 5000;
      if (authFailure || playbackExpired || reason === "error" || renewalFailures.current >= 2 || sessionRef.current?.mode === "oss" && Date.parse(sessionRef.current.sourceExpiresAt) <= Date.now()) { report(playbackExpired ? new ApiError("FORBIDDEN", "播放授权会话已过期，请重新准备播放；已保存的观看位置会保留") : err); await close().catch(() => {}); }
      else setError(new ApiError("NETWORK_ERROR", "媒体授权续签暂时失败，将有限重试；也可手动重新准备播放"));
    }
  };
  useEffect(() => {
    mounted.current = true;
    const onHidden = () => { if (document.visibilityState === "hidden") save(true); else { const active = sessionRef.current; if (active?.mode === "oss" && (Date.parse(active.renewAfter) <= Date.now() || Date.parse(active.expiresAt) <= Date.now())) void requestRenewal("background"); } };
    const onPageHide = () => { save(true); void close(true).catch(() => {}); };
    document.addEventListener("visibilitychange", onHidden); window.addEventListener("pagehide", onPageHide);
    return () => { mounted.current = false; startController.current?.abort(); save(true); void close(true).catch(() => {}); document.removeEventListener("visibilitychange", onHidden); window.removeEventListener("pagehide", onPageHide); };
  }, []);
  useEffect(() => {
    // 同一秒重复V4签名可返回相同URL；显式load保证错误恢复也重新发起媒体请求。
    if (session && switchingSource.current) element.current?.load();
  }, [session]);
  useEffect(() => {
    if (!session || session.mode !== "oss") return;
    const timer = setInterval(() => {
      const active = sessionRef.current;
      if (active?.mode === "oss" && !failed.current && !renewing.current && !switchingSource.current && Date.now() >= nextRenewalRetry.current && Date.now() >= Date.parse(active.renewAfter)) void requestRenewal("expiry");
    }, 1000);
    return () => clearInterval(timer);
  }, [session]);
  useEffect(() => {
    if (!session) return;
    const heartbeat = async () => {
      const current = sessionRef.current;
      if (!current || failed.current) return;
      try {
        const active = await api.request<PlaybackHeartbeat>(`/api/playback-sessions/${encodeURIComponent(current.id)}/heartbeat`, { method: "POST" });
        if (sessionRef.current?.id !== current.id) return;
        if (Date.parse(active.expiresAt) <= Date.now()) throw new ApiError("SESSION_EXPIRED", "播放会话已过期");
        if (active.id !== current.id || active.videoId !== video.id || active.mode !== current.mode) throw new ApiError("INVALID_RESPONSE", "播放心跳与当前会话不匹配");
        sessionRef.current = { ...sessionRef.current!, expiresAt: active.expiresAt };
      } catch (err) { if (sessionRef.current?.id === current.id) { report(err instanceof ApiError && err.code === "FORBIDDEN" && Date.parse(current.expiresAt) <= Date.now() ? new ApiError("FORBIDDEN", "播放授权会话已过期，请重新准备播放；已保存的观看位置会保留") : err); void close().catch(() => {}); } }
    };
    const timer = setInterval(() => void heartbeat(), 20000);
    return () => clearInterval(timer);
    // 同一应用会话的源续签不能重置独立的心跳周期。
  }, [session?.id]);
  const mediaError = async () => {
    const active = sessionRef.current;
    if (failed.current) return;
    if (switchingSource.current) switchingSource.current = false;
    if (active?.mode === "oss") {
      if (mediaRecoveryAttempts.current < 2) { mediaRecoveryAttempts.current++; await requestRenewal("error"); return; }
      report(new ApiError("STORAGE_UNAVAILABLE", "媒体源重新鉴权重试后仍不可用，请检查网络、授权有效期或原片格式后手动重试")); await close().catch(() => {}); return;
    }
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
    const wasSwitching = switchingSource.current; switchingSource.current = false;
    setRestored(positionRef.current > 0); setState(wasSwitching && !resumeAfterSource.current ? "paused" : "ready"); setError(undefined);
    if (wasSwitching && resumeAfterSource.current) void node.play().catch(() => { desiredPlaying.current = false; setState("paused"); });
  }} onCanPlay={() => { if (!terminal && !switchingSource.current) { mediaRecoveryAttempts.current = 0; setState(element.current?.paused ? desiredPlaying.current ? "ready" : "paused" : "playing"); } }} onPlay={() => { desiredPlaying.current = true; setState("playing"); }} onPause={() => { if (switchingSource.current) return; if (!element.current?.error) desiredPlaying.current = false; if (!terminal) setState("paused"); save(); }} onWaiting={() => { if (!terminal) setState("buffering"); }} onTimeUpdate={() => {
    if (!appliedRef.current || switchingSource.current) return;
    positionRef.current = element.current?.currentTime ?? 0; setPosition(positionRef.current);
    if (Date.now() - savedAt.current > 10000) { savedAt.current = Date.now(); save(); }
  }} onSeeked={() => save()} onEnded={() => { positionRef.current = video.durationSeconds ?? element.current?.currentTime ?? 0; save(); void close().catch(report); setEnded(true); setSession(undefined); setState("idle"); }} onError={() => void mediaError()} /> : <div className="player-placeholder"><p>{playerLabels[state]}</p><button disabled={state === "loading"} onClick={() => void start()}>{state === "loading" ? "正在准备…" : (ended || (video.durationSeconds !== null && video.lastPositionSeconds >= video.durationSeconds - .5)) ? "重新播放" : video.lastPositionSeconds > 0 ? `从 ${duration(video.lastPositionSeconds)} 继续` : "开始播放"}</button></div>}</div><div className="player-status" role="status"><span>{playerLabels[state]}</span><span>{duration(position)} / {duration(video.durationSeconds)}</span></div>{restored && <div className="notice" role="status">已恢复至 {duration(position)}。<button className="secondary" onClick={() => { if (element.current) { element.current.currentTime = 0; positionRef.current = 0; setPosition(0); setRestored(false); save(); } }}>从头开始</button></div>}{error !== undefined && <ErrorNotice error={error} />}{terminal && state !== "expired" && <button className="secondary" onClick={() => { setSession(undefined); void start(); }}>手动重新准备播放</button>}{saveError !== undefined && <ErrorNotice error={saveError} retry={() => save()} />}<p className="muted player-note">{session?.mode === "oss" ? "OSS 直连 · 媒体直接由存储服务传输，按实际有效期续签。退出、撤销或关闭仅停止后续授权，已发链接在剩余有效期内可能继续使用。观看字节尚未同步。" : "代理模式 · 原片通过站内 API 播放。3Mbps 带宽下，高码率视频可能缓冲。"}网站保留原片画质。</p></section>;
}
