import type { Plugin } from "vite";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** 仅显式开发 Mock 注册；不注册任何生产媒体或鉴权路由。 */
export function mockMediaPlugin(): Plugin {
  return { name: "explicit-development-media-fixture", configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (!/^\/api\/videos\/[^/]+\/stream$/.test(url.pathname) || !url.searchParams.get("playbackSessionId")) { next(); return; }
      res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
      if (!req.headers.cookie?.split("; ").includes("ov_dev_mock_session=active")) { res.statusCode = 401; res.end(); return; }
      if (req.method !== "GET" && req.method !== "HEAD") { res.statusCode = 405; res.end(); return; }
      const fixture = fileURLToPath(new URL(url.pathname.includes("video-city") ? "./fixtures/portrait.webm" : "./fixtures/demo.webm", import.meta.url));
      let size: number;
      try { size = (await stat(fixture)).size; } catch { res.statusCode = 503; res.end(); return; }
      let start = 0, end = size - 1;
      const range = req.headers.range;
      if (range) {
        const match = range.match(/^bytes=(\d*)-(\d*)$/);
        if (!match || (!match[1] && !match[2])) { res.statusCode = 416; res.setHeader("Content-Range", `bytes */${size}`); res.end(); return; }
        if (!match[1]) start = Math.max(0, size - Number(match[2]));
        else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
        if (start > end || start >= size) { res.statusCode = 416; res.setHeader("Content-Range", `bytes */${size}`); res.end(); return; }
        res.statusCode = 206; res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
      }
      res.setHeader("Accept-Ranges", "bytes"); res.setHeader("Content-Type", "video/webm"); res.setHeader("Content-Length", end - start + 1);
      if (req.method === "HEAD") { res.end(); return; }
      const stream = createReadStream(fixture, { start, end });
      res.on("close", () => stream.destroy()); stream.on("error", () => res.destroy()); stream.pipe(res);
    });
  } };
}
