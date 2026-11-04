import type { SpaceDevice } from "../space-meteor-settings";

export const blessingWords = [
  "祝你未来可期",
  "愿你砥砺前行",
  "你真的很出色",
  "相信你会闪闪发光",
  "愿你乘风破浪",
  "祝你前程似锦",
  "你值得所有美好",
  "愿你向阳而生",
  "相信你会大放异彩",
  "愿你意气风发"
] as const;
export const BLESSING_REVEAL_MS = 650;
export const BLESSING_DURATION_MS = 5200;
export const BLESSING_STATIC_MS = 2200;
const colors = ["#a7efff", "#ffd68d", "#83caff", "#ffb5a7"] as const;

interface BlessingMeteor { x: number; y: number; dx: number; dy: number; angle: number; duration: number; delay: number; color: string }
interface BlessingRay { x: number; y: number; angle: number; delay: number; color: string }
export interface BlessingBurst { word: typeof blessingWords[number]; motion: boolean; meteors: BlessingMeteor[]; rays: BlessingRay[] }

export function createBlessingBurst(device: SpaceDevice, width: number, height: number, motion: boolean, random: () => number = Math.random): BlessingBurst {
  const unit = () => { const value = random(); return Number.isFinite(value) ? Math.max(0, Math.min(.999999999, value)) : .5; };
  const word = blessingWords[Math.floor(unit() * blessingWords.length)]!;
  const meteors = Array.from({ length: motion ? Math.min(device.hardLimit, 18) : 0 }, (_, index) => {
    const dx = -(.4 + unit() * .5) * width; const dy = (.28 + unit() * .42) * height;
    return { x: (index === 0 ? .55 + unit() * .25 : .08 + unit() * 1.05) * width, y: (index === 0 ? .08 + unit() * .3 : -.12 + unit() * .92) * height, dx, dy, angle: Math.atan2(-dy, -dx) * 180 / Math.PI, duration: 1000 + unit() * 250, delay: index === 0 ? 0 : unit() * 600, color: colors[index % colors.length]! };
  });
  const count = device.kind === "mobile" ? 12 : 20;
  const rays = Array.from({ length: motion ? count : 0 }, (_, index) => {
    const angle = (index / count * 360 + unit() * 10) * Math.PI / 180; const distance = 18 + unit() * 17;
    return { x: Math.cos(angle) * distance, y: Math.sin(angle) * distance, angle: angle * 180 / Math.PI, delay: index * 14, color: colors[index % colors.length]! };
  });
  return { word, motion, meteors, rays };
}
