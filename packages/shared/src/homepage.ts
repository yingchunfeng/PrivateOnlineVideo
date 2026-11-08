export interface HomepageVideo { id: string; title: string; categoryId: string }
export interface HomepageSettings {
  version: number;
  categoryRandomEnabled: boolean;
  videoOrder: string[];
  videos: HomepageVideo[];
  persistenceAvailable: boolean;
}
export interface UpdateHomepageSettingsRequest {
  version: number;
  categoryRandomEnabled: boolean;
  videoOrder: string[];
}

function score(seed: string, id: string): number {
  let value = 2166136261;
  for (const char of `${seed}:${id}`) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  value ^= value >>> 16; value = Math.imul(value, 0x85ebca6b);
  value ^= value >>> 13; value = Math.imul(value, 0xc2b2ae35);
  return (value ^ value >>> 16) >>> 0;
}

/** 会话种子固定代表视频，先排完整列表再分页；不改变剩余视频的手动顺序。 */
export function orderHomepageVideos<T extends { id: string; categoryId: string }>(videos: readonly T[], videoOrder: readonly string[], categoryIds: readonly string[], seed?: string): T[] {
  const positions = new Map(videoOrder.map((id, index) => [id, index]));
  const ordered = [...videos].sort((a, b) => (positions.get(a.id) ?? Infinity) - (positions.get(b.id) ?? Infinity));
  if (!seed) return ordered;
  const representatives = new Map<string, { video: T; score: number }>();
  for (const video of ordered) {
    const rank = score(seed, video.id); const previous = representatives.get(video.categoryId);
    if (!previous || rank < previous.score || rank === previous.score && video.id < previous.video.id) representatives.set(video.categoryId, { video, score: rank });
  }
  const categories = [...new Set([...categoryIds, ...representatives.keys()])];
  const first = categories.flatMap(id => { const entry = representatives.get(id); return entry ? [entry.video] : []; });
  const selected = new Set(first.map(video => video.id));
  return [...first, ...ordered.filter(video => !selected.has(video.id))];
}
