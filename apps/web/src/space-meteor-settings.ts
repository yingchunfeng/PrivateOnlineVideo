export const SPACE_EFFECTS_STORAGE_KEY = "ov.space-effects.v1";
export const METEOR_COLORS = ["cyan", "blue", "violet", "rose", "gold"] as const;
export type MeteorColor = typeof METEOR_COLORS[number];

export interface MeteorModeSettings {
  enabled: boolean;
  batchMin: number;
  batchMax: number;
  maxVisible: number;
  intervalMin: number;
  intervalMax: number;
  sizeMin: number;
  sizeMax: number;
  durationMin: number;
  durationMax: number;
  tailScale: number;
  glow: number;
  foreground: boolean;
  foregroundRatio: number;
  colors: MeteorColor[];
  dualColor: boolean;
}

export interface ShowerSettings extends MeteorModeSettings {
  probability: number;
  duration: number;
  cooldown: number;
}

export interface SpaceEffectsSettings {
  normal: MeteorModeSettings;
  shower: ShowerSettings;
  other: { nebula: boolean; navigation: boolean; completion: boolean; entrance: boolean };
}

export interface SpaceDevice {
  kind: "desktop" | "mobile" | "constrained";
  hardLimit: number;
  minInterval: number;
  maxSize: number;
  foreground: boolean;
}

export const DEFAULT_SPACE_SETTINGS: SpaceEffectsSettings = {
  normal: { enabled: true, batchMin: 1, batchMax: 3, maxVisible: 6, intervalMin: .6, intervalMax: 1.8, sizeMin: .6, sizeMax: 2.4, durationMin: 1.2, durationMax: 2.8, tailScale: 1, glow: 1, foreground: true, foregroundRatio: 20, colors: [...METEOR_COLORS], dualColor: true },
  shower: { enabled: true, probability: 5, duration: 8, cooldown: 60, batchMin: 3, batchMax: 6, maxVisible: 24, intervalMin: .16, intervalMax: .38, sizeMin: .4, sizeMax: 2, durationMin: 1, durationMax: 2.4, tailScale: .85, glow: .8, foreground: true, foregroundRatio: 18, colors: [...METEOR_COLORS], dualColor: true },
  other: { nebula: true, navigation: true, completion: true, entrance: true }
};

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function number(value: unknown, fallback: number, min: number, max: number, integer = false) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const bounded = Math.max(min, Math.min(max, value));
  return integer ? Math.round(bounded) : Math.round(bounded * 100) / 100;
}
function boolean(value: unknown, fallback: boolean) { return typeof value === "boolean" ? value : fallback; }
function mode(value: unknown, fallback: MeteorModeSettings): MeteorModeSettings {
  const input = record(value);
  const result: MeteorModeSettings = {
    enabled: boolean(input.enabled, fallback.enabled),
    batchMin: number(input.batchMin, fallback.batchMin, 1, 24, true), batchMax: number(input.batchMax, fallback.batchMax, 1, 24, true),
    maxVisible: number(input.maxVisible, fallback.maxVisible, 1, 48, true),
    intervalMin: number(input.intervalMin, fallback.intervalMin, .1, 60), intervalMax: number(input.intervalMax, fallback.intervalMax, .1, 60),
    sizeMin: number(input.sizeMin, fallback.sizeMin, .2, 4), sizeMax: number(input.sizeMax, fallback.sizeMax, .2, 4),
    durationMin: number(input.durationMin, fallback.durationMin, .5, 8), durationMax: number(input.durationMax, fallback.durationMax, .5, 8),
    tailScale: number(input.tailScale, fallback.tailScale, .3, 3), glow: number(input.glow, fallback.glow, 0, 2),
    foreground: boolean(input.foreground, fallback.foreground), foregroundRatio: number(input.foregroundRatio, fallback.foregroundRatio, 0, 100),
    colors: Array.isArray(input.colors) ? [...new Set(input.colors.filter((color): color is MeteorColor => METEOR_COLORS.includes(color as MeteorColor)))] : [...fallback.colors],
    dualColor: boolean(input.dualColor, fallback.dualColor)
  };
  if (!result.colors.length) result.colors = [...fallback.colors];
  for (const [low, high] of [["batchMin", "batchMax"], ["intervalMin", "intervalMax"], ["sizeMin", "sizeMax"], ["durationMin", "durationMax"]] as const) {
    if (result[low] > result[high]) [result[low], result[high]] = [result[high], result[low]];
  }
  return result;
}

export function normalizeSpaceSettings(value: unknown): SpaceEffectsSettings {
  const input = record(value); const shower = record(input.shower); const other = record(input.other);
  return {
    normal: mode(input.normal, DEFAULT_SPACE_SETTINGS.normal),
    shower: { ...mode(input.shower, DEFAULT_SPACE_SETTINGS.shower), probability: number(shower.probability, 5, 0, 100), duration: number(shower.duration, 8, 1, 30), cooldown: number(shower.cooldown, 60, 5, 600) },
    other: { nebula: boolean(other.nebula, true), navigation: boolean(other.navigation, true), completion: boolean(other.completion, true), entrance: boolean(other.entrance, true) }
  };
}

export function detectSpaceDevice(width: number, cores = 8, memory = 8): SpaceDevice {
  if (width <= 600) return { kind: "mobile", hardLimit: 8, minInterval: .35, maxSize: 1.5, foreground: false };
  if (cores <= 4 || memory <= 4) return { kind: "constrained", hardLimit: 16, minInterval: .25, maxSize: 2, foreground: true };
  return { kind: "desktop", hardLimit: 48, minInterval: .1, maxSize: 4, foreground: true };
}

export function effectiveSpaceSettings(settings: SpaceEffectsSettings, device: SpaceDevice): SpaceEffectsSettings {
  const constrain = (value: MeteorModeSettings, normal: boolean): MeteorModeSettings => {
    const maxVisible = Math.min(value.maxVisible, device.hardLimit, normal && device.kind === "mobile" ? 4 : 48);
    return {
      ...value, maxVisible,
      batchMin: Math.min(value.batchMin, maxVisible), batchMax: Math.min(value.batchMax, maxVisible),
      intervalMin: Math.max(value.intervalMin, device.minInterval), intervalMax: Math.max(value.intervalMax, device.minInterval),
      sizeMin: Math.min(value.sizeMin, device.maxSize), sizeMax: Math.min(value.sizeMax, device.maxSize),
      foreground: value.foreground && device.foreground
    };
  };
  return { normal: constrain(settings.normal, true), shower: { ...settings.shower, ...constrain(settings.shower, false) }, other: settings.other };
}

export function readSpaceSettings(storage: Pick<Storage, "getItem">): SpaceEffectsSettings {
  try { return normalizeSpaceSettings(JSON.parse(storage.getItem(SPACE_EFFECTS_STORAGE_KEY) ?? "null")); } catch { return normalizeSpaceSettings(null); }
}
