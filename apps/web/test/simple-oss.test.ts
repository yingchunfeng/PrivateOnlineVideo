import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultLibraryCategory, libraryTags, libraryVideoPath, parseTagFilter, publicMediaUrl } from "../src/library-data";

test("配置顺序、空分类及停用分类保留，默认上传选择启用项", () => {
  const categories = [{ id: "old", name: "旧类", tags: [], enabled: false }, { id: "zeta", name: "首类", tags: ["旅行", "逗号,标签"] }, { id: "alpha", name: "空类", tags: [] }];
  assert.equal(defaultLibraryCategory(categories), "zeta"); assert.deepEqual(libraryTags(categories, "alpha"), []); assert.deepEqual(libraryTags(categories), ["旅行", "逗号,标签"]);
});
test("多标签搜索序列化支持逗号标签，不把名称拆成多个标签", () => {
  const tags = ["旅行", "逗号,标签"]; const path = libraryVideoPath(2, "视频标题", "zeta", tags); const url = new URL(path, "https://site.invalid");
  assert.deepEqual(JSON.parse(url.searchParams.get("tags")!), tags); assert.equal(url.searchParams.get("categoryId"), "zeta"); assert.equal(url.searchParams.get("page"), "2");
  assert.deepEqual(parseTagFilter(JSON.stringify(tags)), tags); assert.deepEqual(parseTagFilter("invalid"), []);
});
test("公共媒体地址只接受固定媒体域名与无签名onlineVideo路径", () => {
  const source = "https://oss.meetdawn.top/onlineVideo/old.mp4"; assert.equal(publicMediaUrl(source, { mediaBaseUrl: "https://oss.meetdawn.top", objectPrefix: "onlineVideo/" }), source);
  for (const invalid of ["https://evil.example/onlineVideo/v.mp4", "http://oss.meetdawn.top/onlineVideo/v.mp4", `${source}?Signature=old`, `${source}#old`, "https://oss.meetdawn.top/private/v.mp4", "https://user:password@oss.meetdawn.top/onlineVideo/v.mp4", "https://oss.meetdawn.top/onlineVideo/%5cprivate.mp4"]) assert.throws(() => publicMediaUrl(invalid, { mediaBaseUrl: "https://oss.meetdawn.top", objectPrefix: "onlineVideo/" }));
});
