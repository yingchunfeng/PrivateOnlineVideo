import type { VideoSummary } from "@online-video/shared";

export type LibraryEncouragementKind = "cheer" | "orbit";
export interface LibraryEncouragementMessage { id: string; text: string; kind: LibraryEncouragementKind }
export type LibraryFeedEntry =
  | { kind: "video"; id: string; video: VideoSummary; roomy: boolean }
  | { kind: "encouragement"; id: string; messages: readonly LibraryEncouragementMessage[] };

export const encouragementMessages: readonly LibraryEncouragementMessage[] = [
  "今天也请对自己温柔一点",
  "慢慢来，你已经在向前了",
  "每一份认真，都值得被看见",
  "愿你今天遇见一点小幸运",
  "平凡的日子，也会闪闪发光",
  "把小美好收藏，把烦恼放下",
  "你走过的每一步，都算数",
  "愿所有努力，都有温柔回响",
  "累了就歇一歇，不必着急",
  "今天的你，也值得一个赞",
  "愿你心有暖阳，身边有光",
  "生活偶有风雨，也总有晴天",
  "不必完美，真实就很珍贵",
  "愿你所遇皆暖，所行皆坦途",
  "认真生活的样子，真的很棒",
  "把快乐放大，把遗憾缩小",
  "愿今天的好心情陪你久一点",
  "每个普通瞬间，都值得珍藏",
  "你比自己想象的更有力量",
  "愿你的期待，慢慢变成日常",
  "别忘了，也给自己一点掌声",
  "小小的进步，也是大大的好",
  "愿你忙有所值，闲有所趣",
  "日子不必很满，快乐刚好就好",
  "愿你一路向前，也一路被爱",
  "今天的光，正在为你而来",
  "好好吃饭，好好拥抱生活",
  "愿你眼里有光，心里有方向",
  "谢谢你，留下这些美好片段",
  "明天的惊喜，正在路上",
].map((text, index): LibraryEncouragementMessage => ({ id: `encouragement-${index + 1}`, text, kind: index % 2 ? "orbit" : "cheer" }));

export function selectEncouragementMessages(random: () => number = Math.random): LibraryEncouragementMessage[] {
  const pool = [...encouragementMessages];
  for (let index = 0; index < 3; index++) {
    const chosen = index + Math.floor(random() * (pool.length - index));
    [pool[index], pool[chosen]] = [pool[chosen]!, pool[index]!];
  }
  return pool.slice(0, 3);
}

export function buildLibraryFeed(videos: readonly VideoSummary[], messages: readonly LibraryEncouragementMessage[]): LibraryFeedEntry[] {
  const entries: LibraryFeedEntry[] = [];
  videos.forEach((video, index) => {
    entries.push({ kind: "video", id: `video:${video.id}`, video, roomy: index === 0 || index === 5 });
    if (index === 1 && videos.length >= 4) entries.push({ kind: "encouragement", id: "library-encouragement", messages });
  });
  return entries;
}
