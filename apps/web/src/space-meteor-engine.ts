import { DEFAULT_SPACE_SETTINGS, detectSpaceDevice, effectiveSpaceSettings, normalizeSpaceSettings } from "./space-meteor-settings";
import type { MeteorColor, MeteorModeSettings, SpaceDevice, SpaceEffectsSettings } from "./space-meteor-settings";

export type MeteorPreviewMode = "normal" | "shower";
export interface SpaceMeteor {
  id: number; mode: MeteorPreviewMode; layer: "background" | "foreground";
  born: number; expires: number; duration: number; size: number;
  x: number; y: number; dx: number; dy: number; angle: number;
  color: MeteorColor; tail: MeteorColor; tailScale: number; glow: number;
}
export interface MeteorSafety { allowed: boolean; input: boolean; }
export interface MeteorSnapshot { meteors: SpaceMeteor[]; previewMode: MeteorPreviewMode | null; shower: boolean; draining: boolean; nextAt: number; }

// 时间由调用方推进；内部不注册计时器，也不按帧工作。
export class SpaceMeteorEngine {
  private settings: SpaceEffectsSettings;
  private device: SpaceDevice;
  private safety: MeteorSafety = { allowed: false, input: false };
  private meteors: SpaceMeteor[] = [];
  private nextEmission = Infinity;
  private shower: { start: number; end: number } | null = null;
  private draining = false;
  private cooldownStart = -Infinity;
  private previewMode: MeteorPreviewMode | null = null;
  private previewUntil = Infinity;
  private id = 0;
  private width = 1440;
  private height = 900;

  constructor(private random: () => number = Math.random, settings: SpaceEffectsSettings = DEFAULT_SPACE_SETTINGS, device: SpaceDevice = detectSpaceDevice(1440)) {
    this.device = device; this.settings = effectiveSpaceSettings(normalizeSpaceSettings(settings), device);
  }
  private unit() { const value = this.random(); return Number.isFinite(value) ? Math.max(0, Math.min(.999999999, value)) : .5; }
  private between(min: number, max: number) { return min + this.unit() * (max - min); }
  private interval(mode: MeteorModeSettings) { return this.between(mode.intervalMin, mode.intervalMax) * 1000; }
  private trim(cap: number) { this.meteors = this.meteors.slice(0, Math.min(cap, this.device.hardLimit)); }
  private clear(now: number) {
    if (this.shower) this.cooldownStart = Math.max(this.cooldownStart, now);
    this.meteors = []; this.shower = null; this.draining = false; this.previewMode = null; this.previewUntil = Infinity;
    this.nextEmission = this.safety.allowed ? now + this.interval(this.settings.normal) : Infinity;
  }
  configure(settings: SpaceEffectsSettings, device: SpaceDevice, now: number, width = this.width, height = this.height) {
    this.device = device; this.settings = effectiveSpaceSettings(normalizeSpaceSettings(settings), device); this.width = width; this.height = height;
    if (this.shower) {
      this.shower.end = this.shower.start + this.settings.shower.duration * 1000;
      if (this.previewMode === "shower") this.previewUntil = this.shower.end;
    }
    const cap = Math.min(device.hardLimit, this.shower || this.draining ? this.settings.shower.maxVisible : this.settings.normal.maxVisible);
    this.meteors = this.meteors.filter(meteor => meteor.layer === "background" || device.foreground && this.settings[meteor.mode].foreground).slice(0, cap);
    if (this.safety.allowed) {
      const mode = this.shower ? this.settings.shower : this.settings.normal;
      // 新配置在下一次机会生效，不补发此前错过的批次。
      this.nextEmission = now + this.interval(mode);
    }
  }
  setSafety(safety: MeteorSafety, now: number) {
    const resumed = !this.safety.allowed && safety.allowed;
    const stopped = this.safety.allowed && !safety.allowed;
    this.safety = safety;
    if (stopped) this.clear(now);
    if (resumed) this.nextEmission = now + this.interval(this.settings.normal);
  }
  preview(mode: MeteorPreviewMode, now: number) {
    if (!this.safety.allowed || this.previewMode === mode) return false;
    this.clear(now); this.previewMode = mode;
    this.previewUntil = now + (mode === "shower" ? this.settings.shower.duration : 6) * 1000;
    if (mode === "shower") this.shower = { start: now, end: this.previewUntil };
    this.nextEmission = now;
    return true;
  }
  stopPreview(now: number) { if (this.previewMode) this.clear(now); }
  private create(mode: MeteorPreviewMode, config: MeteorModeSettings, now: number): SpaceMeteor {
    // 路径与尺寸分开生成；尺寸仅影响子元素，不缩放位移容器。
    const x = this.between(.1, 1.14) * this.width; const y = this.between(-.12, .82) * this.height;
    const dx = -this.between(.48, 1.12) * this.width; const dy = this.between(.28, .82) * this.height;
    const duration = this.between(config.durationMin, config.durationMax) * 1000;
    const size = config.sizeMin + Math.pow(this.unit(), 1.55) * (config.sizeMax - config.sizeMin);
    const color = config.colors[Math.floor(this.unit() * config.colors.length)]!;
    const tail = config.dualColor && config.colors.length > 1 ? config.colors[(config.colors.indexOf(color) + 1 + Math.floor(this.unit() * (config.colors.length - 1))) % config.colors.length]! : color;
    const layer = config.foreground && !this.safety.input && this.unit() * 100 < config.foregroundRatio ? "foreground" : "background";
    return { id: ++this.id, mode, layer, born: now, expires: now + duration, duration, size, x, y, dx, dy, angle: Math.atan2(-dy, -dx) * 180 / Math.PI, color, tail, tailScale: config.tailScale, glow: config.glow };
  }
  tick(now: number): MeteorSnapshot {
    this.meteors = this.meteors.filter(meteor => meteor.expires > now);
    if (!this.safety.allowed) return this.snapshot();
    if (this.previewMode && now >= this.previewUntil) {
      this.previewMode = null; this.previewUntil = Infinity;
    }
    if (this.shower && now >= this.shower.end) {
      this.cooldownStart = this.shower.end;
      this.shower = null; this.draining = this.meteors.some(meteor => meteor.mode === "shower");
      if (!this.draining) this.trim(this.settings.normal.maxVisible);
      this.nextEmission = now + this.interval(this.settings.normal);
    }
    if (this.draining && !this.meteors.some(meteor => meteor.mode === "shower")) {
      this.draining = false;
      this.trim(this.settings.normal.maxVisible);
      this.nextEmission = now + this.interval(this.settings.normal);
    }
    if (!this.draining && now >= this.nextEmission) {
      if (!this.shower && !this.previewMode && this.settings.normal.enabled && this.settings.shower.enabled && !this.safety.input && now >= this.cooldownStart + this.settings.shower.cooldown * 1000 && this.settings.shower.probability > 0 && this.unit() * 100 < this.settings.shower.probability) {
        this.shower = { start: now, end: now + this.settings.shower.duration * 1000 };
        this.trim(this.settings.shower.maxVisible);
      }
      const mode = this.shower ? "shower" : "normal";
      const config = this.settings[mode];
      if (config.enabled || this.previewMode === mode) {
        const base = Math.floor(this.between(config.batchMin, config.batchMax + 1));
        const ramp = this.shower ? Math.max(.25, Math.min(1, (now - this.shower.start + 250) / 1400, (this.shower.end - now) / 1200)) : 1;
        const room = Math.max(0, Math.min(config.maxVisible, this.device.hardLimit) - this.meteors.length);
        const batch = Math.round(config.batchMin + (base - config.batchMin) * ramp);
        const count = room < config.batchMin ? 0 : Math.min(batch, room);
        for (let index = 0; index < count; index++) this.meteors.push(this.create(mode, config, now));
      }
      this.nextEmission = now + this.interval(config);
    }
    return this.snapshot();
  }
  snapshot(): MeteorSnapshot {
    const active = this.shower ? this.settings.shower : this.settings.normal;
    const canEmit = this.safety.allowed && !this.draining && (active.enabled || this.previewMode !== null);
    return { meteors: this.meteors, previewMode: this.previewMode, shower: this.shower !== null, draining: this.draining, nextAt: Math.min(canEmit ? this.nextEmission : Infinity, this.shower?.end ?? Infinity, this.previewUntil, ...this.meteors.map(meteor => meteor.expires)) };
  }
}
