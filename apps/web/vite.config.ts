import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { mockMediaPlugin } from "./test/mock-media-plugin.ts";
import { fileURLToPath } from "node:url";

export default defineConfig(({ mode, command }) => {
  const previousUserNodeEnvironment = process.env.VITE_USER_NODE_ENV;
  const publicMedia = loadEnv(mode, fileURLToPath(new URL("../..", import.meta.url)), "VITE_");
  // 根.env的NODE_ENV用于API；读取两个公开媒体键不能改变前端生产构建模式。
  if (previousUserNodeEnvironment === undefined) delete process.env.VITE_USER_NODE_ENV;
  else process.env.VITE_USER_NODE_ENV = previousUserNodeEnvironment;
  return ({
  define: Object.fromEntries(["VITE_MEDIA_ORIGIN", "VITE_MEDIA_PREFIX"].filter(key => publicMedia[key] !== undefined).map(key => [`import.meta.env.${key}`, JSON.stringify(publicMedia[key])])),
  plugins: [react(), ...(mode === "mock" && command === "serve" ? [mockMediaPlugin()] : [])],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:3000" } }
  },
  preview: { host: "127.0.0.1", port: 5173, strictPort: true },
  build: { sourcemap: false, emptyOutDir: false }
}); });
