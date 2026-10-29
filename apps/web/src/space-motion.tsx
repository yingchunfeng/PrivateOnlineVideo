import { createContext, useContext, useEffect, useLayoutEffect, useState } from "react";
import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { SpaceMeteorProvider } from "./space-meteors";
import { SpaceMotionSettings } from "./space-motion-settings";

export const spaceMotionStorageKey = "ov.space-motion.v1";
const reducedMotionQuery = "(prefers-reduced-motion: reduce)";
const SpaceMotionContext = createContext<{ enabled: boolean; reduced: boolean; toggle: () => void } | undefined>(undefined);

function readPreference() {
  try { return window.localStorage.getItem(spaceMotionStorageKey) !== "off"; } catch { return true; }
}

export function SpaceMotionProvider({ children }: { children: ReactNode }) {
  const [preferred, setPreferred] = useState(readPreference);
  const [reduced, setReduced] = useState(() => window.matchMedia(reducedMotionQuery).matches);
  const [hidden, setHidden] = useState(() => document.visibilityState === "hidden");
  const [playing, setPlaying] = useState(false);
  const { pathname } = useLocation();
  const enabled = preferred && !reduced;

  useEffect(() => {
    const media = window.matchMedia(reducedMotionQuery);
    const syncReduced = () => setReduced(media.matches);
    const syncVisibility = () => setHidden(document.visibilityState === "hidden");
    const syncStorage = (event: StorageEvent) => {
      if (event.key !== spaceMotionStorageKey && event.key !== null) return;
      try { if (event.storageArea !== window.localStorage) return; } catch { return; }
      setPreferred(readPreference());
    };
    syncReduced();
    syncVisibility();
    media.addEventListener("change", syncReduced);
    document.addEventListener("visibilitychange", syncVisibility);
    window.addEventListener("storage", syncStorage);
    return () => {
      media.removeEventListener("change", syncReduced);
      document.removeEventListener("visibilitychange", syncVisibility);
      window.removeEventListener("storage", syncStorage);
    };
  }, []);

  useEffect(() => {
    // 捕获媒体事件，不改动播放器的播放与进度保存逻辑。
    const syncPlayback = () => setPlaying(Array.from(document.querySelectorAll<HTMLVideoElement>(".player-frame video")).some(video => !video.paused && !video.ended && !video.error));
    const events = ["play", "playing", "pause", "ended", "emptied", "error"];
    const observer = new MutationObserver(records => {
      if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element && (node.matches("video, .player-frame") || node.querySelector(".player-frame video"))))) syncPlayback();
    });
    syncPlayback();
    // 初始化检查会替换 main，观察稳定根节点才能覆盖同路由播放器卸载。
    observer.observe(document.getElementById("root") ?? document.body, { childList: true, subtree: true });
    for (const event of events) document.addEventListener(event, syncPlayback, true);
    return () => {
      observer.disconnect();
      for (const event of events) document.removeEventListener(event, syncPlayback, true);
    };
  }, [pathname]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.spaceMotion = enabled ? "on" : "off";
    root.dataset.spacePaused = hidden || playing ? "true" : "false";
    root.dataset.spacePlaying = playing ? "true" : "false";
    return () => {
      root.removeAttribute("data-space-motion");
      root.removeAttribute("data-space-paused");
      root.removeAttribute("data-space-playing");
    };
  }, [enabled, hidden, playing]);

  const toggle = () => {
    const next = !preferred;
    setPreferred(next);
    try { window.localStorage.setItem(spaceMotionStorageKey, next ? "on" : "off"); } catch { /* 存储受限时仍可在当前页面切换。 */ }
  };
  return <SpaceMotionContext.Provider value={{ enabled, reduced, toggle }}><SpaceMeteorProvider enabled={enabled} paused={hidden || playing}>{children}</SpaceMeteorProvider></SpaceMotionContext.Provider>;
}

export function SpaceMotionToggle() {
  const context = useContext(SpaceMotionContext);
  const [settingsOpen, setSettingsOpen] = useState(false);
  if (!context) throw new Error("Missing SpaceMotionProvider");
  return <div className="space-motion-controls"><button type="button" className="space-motion-toggle" aria-label="动态星空" aria-pressed={context.enabled} disabled={context.reduced} onClick={context.toggle} title={context.reduced ? "系统已启用减少动态效果，当前显示静态星空" : "控制星空与装饰动效，视频播放时自动暂停"}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m12 3 2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2Z" /><path d="M20 2v4m-2-2h4" /></svg>
    <span>动态星空</span><span className="space-motion-status">{context.reduced ? "系统静态" : context.enabled ? "开启" : "关闭"}</span>
  </button><button type="button" className="space-settings-trigger" aria-label="星空动效设置" aria-haspopup="dialog" onClick={() => setSettingsOpen(true)} title="配置流星、流星雨与其他动效">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" fill="var(--space-panel)" /><circle cx="15" cy="17" r="3" fill="var(--space-panel)" /></svg>
  </button>{settingsOpen && <SpaceMotionSettings enabled={context.enabled} reduced={context.reduced} onClose={() => setSettingsOpen(false)} />}</div>;
}
