import assert from "node:assert/strict";
import test from "node:test";
import { orderHomepageVideos } from "@online-video/shared";

const videos = Array.from({ length: 60 }, (_, index) => ({ id: `video-${index}`, categoryId: `category-${index % 15}` }));
const categories = Array.from({ length: 15 }, (_, index) => `category-${index}`);

test("首页分类随机：每个非空分类一个，完整排序后分页无重漏，同一会话稳定", () => {
  const original = structuredClone(videos);
  const sorted = orderHomepageVideos(videos, [], [...categories, "empty"], "session-a");
  assert.deepEqual(sorted.slice(0, 15).map(video => video.categoryId), categories);
  assert.equal(new Set(sorted.map(video => video.id)).size, videos.length);
  assert.deepEqual(sorted, orderHomepageVideos(videos, [], categories, "session-a"));
  assert.deepEqual([...sorted.slice(0, 12), ...sorted.slice(12, 24), ...sorted.slice(24)], sorted);
  assert.notDeepEqual(sorted.slice(0, 15), orderHomepageVideos(videos, [], categories, "session-b").slice(0, 15));
  assert.deepEqual(videos, original);
});

test("首页手动排序：开关关闭不前置；新视频排在已排序之后；历史失效ID不占位", () => {
  const manual = [videos[8]!.id, "deleted", videos[2]!.id];
  const sorted = orderHomepageVideos(videos, manual, categories);
  assert.deepEqual(sorted.slice(0, 2), [videos[8], videos[2]]);
  assert.deepEqual(sorted.slice(2), videos.filter(video => video.id !== videos[8]!.id && video.id !== videos[2]!.id));
  assert.deepEqual(orderHomepageVideos([], manual, categories, "session-a"), []);
  const first = orderHomepageVideos(videos, manual, categories, "session-a");
  const selected = new Set(first.slice(0, 15).map(video => video.id));
  assert.deepEqual(first.slice(15), sorted.filter(video => !selected.has(video.id)));
});
