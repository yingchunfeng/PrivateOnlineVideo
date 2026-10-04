import { test } from "node:test";
import assert from "node:assert/strict";
import { validateMediaUrl, validateProxySource } from "../src/media-policy";

test("媒体域名/协议/前缀边界严格校验，不泄漏签名URL", () => {
  const policy = { origin: "https://oss.example", prefix: "/onlineVideo/" };
  assert.equal(validateMediaUrl("https://oss.example/onlineVideo/a.mp4?signature=opaque", policy), "https://oss.example/onlineVideo/a.mp4?signature=opaque");
  assert.equal(validateMediaUrl("https://oss.example/onlineVideo/%E6%9D%AD%E5%B7%9E%20%E5%A4%9C%E6%99%AF.mp4", policy), "https://oss.example/onlineVideo/%E6%9D%AD%E5%B7%9E%20%E5%A4%9C%E6%99%AF.mp4");
  for (const value of ["javascript:alert(1)", "//oss.example/onlineVideo/a", "http://oss.example/onlineVideo/a", "https://evil.example/onlineVideo/a", "https://oss.example.evil/onlineVideo/a", "https://user:secret@oss.example/onlineVideo/a", "https://oss.example:444/onlineVideo/a", "https://oss.example/onlineVideo-other/a", "https://oss.example/onlineVideo/", "https://oss.example/onlineVideo/../other/a", "https://oss.example/onlineVideo/%2e%2e/other/a", "https://oss.example/onlineVideo/%252e%252e/other/a", "https://oss.example/onlineVideo/%2fother/a", "https://oss.example/onlineVideo/%5cevil", "https://oss.example/onlineVideo/a#secret", "https://oss.example\\@evil.example/onlineVideo/a"]) {
    assert.throws(() => validateMediaUrl(value, policy), error => error instanceof Error && !error.message.includes("signature="));
  }
  for (const prefix of ["/", "/onlineVideo", "//onlineVideo/", "/onlineVideo/../", "/onlineVideo/%2f/"]) assert.throws(() => validateMediaUrl("https://oss.example/onlineVideo/a", { ...policy, prefix }));
});

test("HTTP媒体替身只允许明确配置的回环开发地址", () => {
  const local = { origin: "http://127.0.0.1:4101", prefix: "/onlineVideo/", allowLocalHttp: true };
  assert.equal(validateMediaUrl("http://127.0.0.1:4101/onlineVideo/a", local), "http://127.0.0.1:4101/onlineVideo/a");
  assert.throws(() => validateMediaUrl("http://127.0.0.1:4101/onlineVideo/a", { ...local, allowLocalHttp: false }));
  assert.throws(() => validateMediaUrl("http://192.168.0.2/onlineVideo/a", { ...local, origin: "http://192.168.0.2" }));
});

test("proxy只允许当前视频与应用会话的站内stream", () => {
  validateProxySource("/api/videos/video-1/stream?playbackSessionId=session-1", "video-1", "session-1");
  for (const value of ["/api/videos/video-2/stream?playbackSessionId=session-1", "/api/videos/video-1/stream?playbackSessionId=other", "/api/videos/video-1/stream?playbackSessionId=session-1&url=evil", "https://oss.example/onlineVideo/a"]) assert.throws(() => validateProxySource(value, "video-1", "session-1"));
});
