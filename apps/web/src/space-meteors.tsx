import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { SpaceMeteorEngine } from "./space-meteor-engine";
import type { MeteorPreviewMode, MeteorSnapshot } from "./space-meteor-engine";
import { detectSpaceDevice, effectiveSpaceSettings, normalizeSpaceSettings, SPACE_EFFECTS_STORAGE_KEY } from "./space-meteor-settings";
import type { SpaceDevice, SpaceEffectsSettings } from "./space-meteor-settings";

interface SpaceMeteorContextValue {
  settings: SpaceEffectsSettings;
  effective: SpaceEffectsSettings;
  device: SpaceDevice;
  storageAvailable: boolean;
  previewMode: MeteorPreviewMode | null;
  updateSettings: (next: SpaceEffectsSettings) => void;
  resetSettings: () => void;
  preview: (mode: MeteorPreviewMode) => void;
  stopPreview: () => void;
  snapshot: MeteorSnapshot;
}
const SpaceMeteorContext = createContext<SpaceMeteorContextValue | undefined>(undefined);
const emptySnapshot: MeteorSnapshot = { meteors: [], previewMode: null, shower: false, draining: false, nextAt: Infinity };

function devicePreference() {
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  return detectSpaceDevice(window.innerWidth, navigator.hardwareConcurrency || 8, memory);
}
function storedPreference() {
  try {
    const raw = window.localStorage.getItem(SPACE_EFFECTS_STORAGE_KEY);
    let parsed: unknown;
    try { parsed = JSON.parse(raw ?? "null"); } catch { parsed = null; }
    return { settings: normalizeSpaceSettings(parsed), available: true };
  }
  catch { return { settings: normalizeSpaceSettings(null), available: false }; }
}

export function SpaceMeteorProvider({ enabled, paused, children }: { enabled: boolean; paused: boolean; children: ReactNode }) {
  const [initial] = useState(storedPreference);
  const [settings, setSettings] = useState(initial.settings);
  const [storageAvailable, setStorageAvailable] = useState(initial.available);
  const [device, setDevice] = useState(devicePreference);
  const [snapshot, setSnapshot] = useState<MeteorSnapshot>(emptySnapshot);
  const engine = useRef<SpaceMeteorEngine | null>(null);
  if (!engine.current) engine.current = new SpaceMeteorEngine(Math.random, settings, device);
  const flags = useRef({ enabled, paused });
  flags.current = { enabled, paused };
  const drive = useRef<() => void>(() => undefined);

  useEffect(() => {
    const current = engine.current!;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const step = () => {
      if (disposed) return;
      if (timer !== undefined) clearTimeout(timer);
      const now = performance.now();
      const businessDialog = !!document.querySelector('dialog[open]:not([data-space-settings]), [role="alertdialog"][aria-modal="true"]:not([data-space-settings]), [role="dialog"][aria-modal="true"]:not([data-space-settings])');
      const input = document.activeElement instanceof Element && document.activeElement.matches('input, textarea, select, [contenteditable="true"], [contenteditable=""]');
      const allowed = flags.current.enabled && !flags.current.paused && document.visibilityState !== "hidden" && !businessDialog;
      document.documentElement.dataset.spaceMeteorBlocked = allowed ? "false" : "true";
      document.documentElement.dataset.spaceMeteorInput = input ? "true" : "false";
      current.setSafety({ allowed, input }, now);
      const next = current.tick(now);
      setSnapshot(next);
      if (Number.isFinite(next.nextAt)) timer = setTimeout(step, Math.max(16, next.nextAt - now));
    };
    drive.current = step;
    const resize = () => { setDevice(devicePreference()); };
    const observer = new MutationObserver(records => {
      if (records.some(record => record.type === "attributes" || [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element && (node.matches('dialog, [role="alertdialog"], [role="dialog"]') || node.querySelector('dialog, [role="alertdialog"], [role="dialog"]'))))) step();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open", "aria-modal", "hidden"] });
    document.addEventListener("focusin", step);
    document.addEventListener("focusout", step);
    document.addEventListener("visibilitychange", step);
    window.addEventListener("resize", resize);
    step();
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      observer.disconnect();
      document.removeEventListener("focusin", step);
      document.removeEventListener("focusout", step);
      document.removeEventListener("visibilitychange", step);
      window.removeEventListener("resize", resize);
      drive.current = () => undefined;
    };
  }, []);

  useLayoutEffect(() => {
    engine.current!.configure(settings, device, performance.now(), window.innerWidth, window.innerHeight);
    const root = document.documentElement;
    for (const [key, value] of Object.entries(settings.other)) root.setAttribute(`data-space-${key}`, value ? "on" : "off");
    drive.current();
  }, [settings, device]);
  useLayoutEffect(() => { drive.current(); }, [enabled, paused]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== SPACE_EFFECTS_STORAGE_KEY && event.key !== null) return;
      try {
        if (event.storageArea !== window.localStorage) return;
        const next = storedPreference(); setSettings(next.settings); setStorageAvailable(next.available);
      } catch { setStorageAvailable(false); }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  const updateSettings = (value: SpaceEffectsSettings) => {
    const next = normalizeSpaceSettings(value); setSettings(next);
    try { window.localStorage.setItem(SPACE_EFFECTS_STORAGE_KEY, JSON.stringify(next)); setStorageAvailable(true); }
    catch { setStorageAvailable(false); }
  };
  const preview = (mode: MeteorPreviewMode) => { drive.current(); engine.current!.preview(mode, performance.now()); drive.current(); };
  const stopPreview = () => { engine.current!.stopPreview(performance.now()); drive.current(); };
  return <SpaceMeteorContext.Provider value={{ settings, effective: effectiveSpaceSettings(settings, device), device, storageAvailable, previewMode: snapshot.previewMode, updateSettings, resetSettings: () => updateSettings(normalizeSpaceSettings(null)), preview, stopPreview, snapshot }}>{children}</SpaceMeteorContext.Provider>;
}

export function useSpaceMeteors() {
  const context = useContext(SpaceMeteorContext);
  if (!context) throw new Error("Missing SpaceMeteorProvider");
  return context;
}

export function SpaceMeteors({ layer }: { layer: "background" | "foreground" }) {
  const { snapshot } = useSpaceMeteors();
  return <div className={`space-meteors space-meteors-${layer}`} data-scheduled="true" data-shower={snapshot.shower ? "true" : "false"} data-meteor-phase={snapshot.shower ? "shower" : snapshot.draining ? "draining" : "normal"} aria-hidden="true">
    {snapshot.meteors.filter(meteor => meteor.layer === layer).map(meteor => <span key={meteor.id} className="space-meteor" data-meteor-id={meteor.id} data-meteor-size={meteor.size.toFixed(3)} data-meteor-mode={meteor.mode} style={{ left: `${meteor.x}px`, top: `${meteor.y}px`, "--meteor-dx": `${meteor.dx}px`, "--meteor-dy": `${meteor.dy}px`, "--meteor-angle": `${meteor.angle}deg`, "--meteor-duration": `${meteor.duration}ms`, "--meteor-size": meteor.size, "--meteor-tail-scale": meteor.tailScale, "--meteor-glow": meteor.glow, "--meteor-color": `var(--meteor-${meteor.color})`, "--meteor-tail": `var(--meteor-${meteor.tail})` } as CSSProperties}>
      <span className="meteor-body"><span className="meteor-streak" /><span className="meteor-dust" /><span className="meteor-head" /></span>
    </span>)}
  </div>;
}
