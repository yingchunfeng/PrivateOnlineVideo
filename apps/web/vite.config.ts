import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { mockMediaPlugin } from "./test/mock-media-plugin.ts";

export default defineConfig(({ mode, command }) => ({
  plugins: [react(), ...(mode === "mock" && command === "serve" ? [mockMediaPlugin()] : [])],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:3000" } }
  },
  preview: { host: "127.0.0.1", port: 5173, strictPort: true },
  build: { sourcemap: false, emptyOutDir: false }
}));
