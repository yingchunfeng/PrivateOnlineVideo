import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { captureCoverThumbnail, captureVideoCover, coverFrameTime, coverIntervalTimes, generateLocalCover, loadCoverVideo, releaseCoverVideo, seekCoverVideo } from "../cover";
import type { LocalCover } from "../cover";
import "./cover-picker.css";

interface Props {
  file: File; title: string; initialTime: number | undefined; opener: HTMLElement;
  onCommit: (cover: LocalCover, time?: number) => boolean; onClose: () => void;
}
interface Thumbnail { time: number; url: string }
const timeLabel = (time: number) => {
  const tenths = Math.round(Math.max(0, time) * 10);
  const seconds = Math.floor(tenths / 10);
  const hours = Math.floor(seconds / 3600);
  return `${hours ? `${hours}:` : ""}${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}.${tenths % 10}`;
};
const inputTime = (time: number) => String(Math.round(time * 1000) / 1000);
const reason = (error: unknown) => error instanceof Error ? error.message : "未能读取视频画面，请重试";

export function CoverPicker({ file, title, initialTime, opener, onCommit, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null); const video = useRef<HTMLVideoElement>(null); const closeButton = useRef<HTMLButtonElement>(null);
  const titleId = useId(); const hintId = useId();
  const lifetime = useRef<AbortController | undefined>(undefined); const seekJob = useRef<AbortController | undefined>(undefined);
  const cache = useRef(new Map<number, Thumbnail[]>()); const requestedTime = useRef(0); const actionBusy = useRef(false);
  const [duration, setDuration] = useState(0); const [currentTime, setCurrentTime] = useState(0); const [draft, setDraft] = useState("0");
  const [interval, setInterval] = useState(0); const [thumbnails, setThumbnails] = useState<Thumbnail[]>([]); const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true); const [seeking, setSeeking] = useState(false); const [thumbnailBusy, setThumbnailBusy] = useState(false);
  const [saving, setSaving] = useState<"manual" | "auto" | undefined>(); const [error, setError] = useState(""); const [thumbnailError, setThumbnailError] = useState("");

  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    const node = video.current!; const modal = dialog.current!; const url = URL.createObjectURL(file);
    const overflow = document.body.style.overflow; document.body.style.overflow = "hidden";
    modal.showModal(); closeButton.current?.focus();
    void (async () => {
      try {
        await loadCoverVideo(node, url, controller.signal);
        const target = coverFrameTime(initialTime ?? (node.duration <= 2 ? node.duration / 2 : 1), node.duration);
        await seekCoverVideo(node, target, controller.signal);
        if (controller.signal.aborted) return;
        requestedTime.current = target; setCurrentTime(target); setDraft(inputTime(target));
        setDuration(node.duration); setInterval(Math.floor(target / 10));
      } catch (failure) { if (!controller.signal.aborted) setError(reason(failure)); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => {
      controller.abort(); seekJob.current?.abort(); releaseCoverVideo(node); URL.revokeObjectURL(url);
      cache.current.forEach(items => items.forEach(item => URL.revokeObjectURL(item.url))); cache.current.clear();
      if (modal.open) modal.close(); document.body.style.overflow = overflow;
      queueMicrotask(() => { if (opener.isConnected) opener.focus(); });
    };
  }, [file, initialTime, opener]);

  useEffect(() => {
    if (!duration) return;
    const cached = cache.current.get(interval);
    if (cached) {
      cache.current.delete(interval); cache.current.set(interval, cached);
      setThumbnails(cached); setThumbnailBusy(false); setThumbnailError(""); return;
    }
    // 每个区间只有一个解码器；切换时先中止并释放旧解码器。最多缓存三个区间、30 张小图。
    const controller = new AbortController(); const decoder = document.createElement("video"); const url = URL.createObjectURL(file);
    decoder.muted = true; decoder.playsInline = true; decoder.preload = "auto";
    const generated: Thumbnail[] = []; let retained = false;
    setThumbnails([]); setThumbnailError(""); setThumbnailBusy(true);
    void (async () => {
      try {
        await loadCoverVideo(decoder, url, controller.signal);
        for (const time of coverIntervalTimes(duration, interval)) {
          const blob = await captureCoverThumbnail(decoder, time, controller.signal);
          if (controller.signal.aborted) return;
          generated.push({ time, url: URL.createObjectURL(blob) }); setThumbnails([...generated]);
        }
        if (controller.signal.aborted) return;
        cache.current.set(interval, generated); retained = true;
        if (cache.current.size > 3) {
          const oldest = cache.current.keys().next().value!;
          cache.current.get(oldest)?.forEach(item => URL.revokeObjectURL(item.url)); cache.current.delete(oldest);
        }
      } catch (failure) {
        if (!controller.signal.aborted) { setThumbnails([]); setThumbnailError(`缩略图生成失败：${reason(failure)}。仍可使用视频预览选择。`); }
      } finally {
        releaseCoverVideo(decoder); URL.revokeObjectURL(url);
        if (!retained) generated.forEach(item => URL.revokeObjectURL(item.url));
        if (!controller.signal.aborted) setThumbnailBusy(false);
      }
    })();
    return () => { controller.abort(); releaseCoverVideo(decoder); if (!retained) generated.forEach(item => URL.revokeObjectURL(item.url)); };
  }, [file, duration, interval, retry]);

  const seek = async (time: number) => {
    if (!video.current || !duration || actionBusy.current) return;
    seekJob.current?.abort(); const controller = new AbortController(); seekJob.current = controller;
    try {
      const target = coverFrameTime(time, duration);
      requestedTime.current = target; setCurrentTime(target); setDraft(inputTime(target)); setSeeking(true); setError("");
      setInterval(Math.floor(target / 10));
      await seekCoverVideo(video.current, target, controller.signal);
    } catch (failure) { if (!controller.signal.aborted && !lifetime.current?.signal.aborted) setError(reason(failure)); }
    finally {
      if (seekJob.current === controller) seekJob.current = undefined;
      if (!controller.signal.aborted && !lifetime.current?.signal.aborted) setSeeking(false);
    }
  };
  const jump = () => { if (!draft.trim() || !Number.isFinite(Number(draft))) { setError("请输入有效的时间秒数"); return; } void seek(Number(draft)); };
  const save = async (mode: "manual" | "auto") => {
    const signal = lifetime.current?.signal; const node = video.current;
    if (!signal || signal.aborted || !node || actionBusy.current) return;
    actionBusy.current = true; seekJob.current?.abort(); node.pause(); setSaving(mode); setError("");
    let cover: LocalCover | undefined;
    try {
      cover = mode === "auto" ? await generateLocalCover(file, signal) : await captureVideoCover(node, node.currentTime, signal);
      if (signal.aborted) return;
      if (!onCommit(cover, mode === "manual" ? node.currentTime : undefined)) throw new Error("此视频已移出或提交，无法修改封面");
      cover = undefined; onClose();
    } catch (failure) { if (!signal.aborted) setError(`封面未替换：${reason(failure)}`); }
    finally {
      if (cover) URL.revokeObjectURL(cover.url);
      actionBusy.current = false; if (!signal.aborted) setSaving(undefined);
    }
  };
  const unavailable = loading || !duration || !!saving;
  const intervalCount = Math.max(1, Math.ceil(duration / 10)); const times = coverIntervalTimes(duration, interval);
  return createPortal(<dialog ref={dialog} className="cover-picker" aria-labelledby={titleId} aria-describedby={hintId} onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => {
    if (event.key !== "Tab") return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), video[controls]")].filter(node => node.getClientRects().length);
    const first = controls[0]; const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}>
    <header className="cover-picker-header"><div><small>待上传视频 · 手动封面</small><h2 id={titleId} title={title}>选择封面 · {title}</h2></div><button ref={closeButton} type="button" className="secondary" aria-label="关闭封面选择" onClick={onClose}>×</button></header>
    <div className="cover-picker-body">
      <p id={hintId} className="cover-picker-hint">先选每秒缩略图，再预览或微调时间。点击“使用当前画面”后才替换封面。</p>
      <div className="cover-picker-player"><video ref={video} controls={!saving} playsInline preload="auto" aria-label="封面视频预览" onTimeUpdate={event => {
        const node = event.currentTarget; if (actionBusy.current || seekJob.current) return;
        requestedTime.current = node.currentTime; setCurrentTime(node.currentTime); setDraft(inputTime(node.currentTime));
      }} onSeeking={() => setSeeking(true)} onSeeked={() => { if (!seekJob.current) setSeeking(false); }} onError={() => setError("当前浏览器无法解码此视频，请检查文件或使用其他浏览器；原封面已保留")} />
        {(loading || seeking) && <span className="cover-picker-player-status" role="status">{loading ? "正在读取视频…" : "正在定位画面…"}</span>}
      </div>
      <div className="cover-picker-time"><span aria-label="当前预览时间">{timeLabel(currentTime)}</span><input type="range" min="0" max={duration || 0} step="0.1" value={Math.min(currentTime, duration)} aria-label="预览进度" disabled={unavailable} onChange={event => void seek(Number(event.target.value))} /><span aria-label="视频总时长">{duration ? timeLabel(duration) : "时长暂不可用"}</span></div>
      <div className="cover-picker-section-heading"><div><strong>每秒缩略图</strong><small>{times.length ? `${timeLabel(times[0]!)} – ${timeLabel(times.at(-1)!)} · 第 ${interval + 1} / ${intervalCount} 组` : "等待读取时长"}</small></div><nav aria-label="缩略图时间区间"><button type="button" className="secondary" disabled={unavailable || interval === 0} onClick={() => setInterval(interval - 1)}>上一个时间区间</button><button type="button" className="secondary" disabled={unavailable || interval + 1 >= intervalCount} onClick={() => setInterval(interval + 1)}>下一个时间区间</button></nav></div>
      <div className="cover-picker-thumbnails" aria-label="每秒缩略图" aria-busy={thumbnailBusy}>{times.map(time => {
        const thumbnail = thumbnails.find(item => item.time === time); const selected = Math.floor(currentTime) === time;
        return <button key={time} type="button" className={`secondary cover-picker-thumbnail ${selected ? "selected-time" : ""}`} aria-label={`预览 ${time} 秒`} aria-pressed={selected} disabled={unavailable} onClick={() => void seek(time)}>{thumbnail ? <img src={thumbnail.url} alt="" /> : <span className="cover-picker-thumbnail-placeholder">{thumbnailError ? "暂无缩略图" : "生成中…"}</span>}<span>{timeLabel(time)}</span></button>;
      })}</div>
      <div className="cover-picker-generation" role="status">{thumbnailBusy ? `正在生成缩略图 · ${thumbnails.length} / ${times.length}` : thumbnails.length ? "点击缩略图可暂停并定位" : ""}</div>
      {thumbnailError && <div className="cover-picker-thumbnail-error"><small>{thumbnailError}</small><button type="button" className="secondary" disabled={!!saving} onClick={() => setRetry(retry + 1)}>重试缩略图</button></div>}
      <div className="cover-picker-adjust"><label>跳转时间（秒）<input type="number" min="0" max={duration || undefined} step="0.1" value={draft} disabled={unavailable} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); jump(); } }} /></label><button type="button" className="secondary" disabled={unavailable} onClick={jump}>跳转</button><div className="cover-picker-fine"><span>时间微调</span><button type="button" className="secondary" disabled={unavailable || currentTime <= 0} onClick={() => void seek(requestedTime.current - .1)}>后退 0.1 秒</button><button type="button" className="secondary" disabled={unavailable || currentTime >= duration - .001} onClick={() => void seek(requestedTime.current + .1)}>前进 0.1 秒</button></div></div>
      {error && <div className="notice error cover-picker-error" role="alert">{error}。可取消选图并继续正常上传。</div>}
    </div>
    <footer className="cover-picker-footer"><span role="status">{saving === "manual" ? "正在生成正式封面…" : saving === "auto" ? "正在恢复自动封面…" : "预览不会改变原封面"}</span><div><button type="button" className="secondary" onClick={onClose}>取消</button><button type="button" className="secondary" disabled={!!saving} onClick={() => void save("auto")}>恢复自动封面</button><button type="button" disabled={unavailable || seeking} onClick={() => void save("manual")}>使用当前画面</button></div></footer>
  </dialog>, document.body);
}
