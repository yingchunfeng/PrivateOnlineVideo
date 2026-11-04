import { build } from "vite";
import { createHash } from "node:crypto";
import { access, readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { assertSafeReleaseFile } from "./release-policy.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = join(root, "dist", `stage2-release-${new Date().toISOString().replace(/[:.]/g, "-")}`);
try { await access(output); throw new Error("独立发布目录已存在，拒绝覆盖"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
await build({ root, mode: "production", build: { outDir: output, emptyOutDir: false, sourcemap: false } });
const files: { path: string; bytes: number; sha256: string }[] = [];
async function inspect(directory: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { await inspect(path); continue; }
    const content = await readFile(path); const name = relative(output, path).replace(/\\/g, "/");
    const text = content.toString("utf8");
    assertSafeReleaseFile(name, text);
    files.push({ path: name, bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") });
  }
}
await inspect(output);
await writeFile(join(output, "manifest.json"), JSON.stringify({ createdAt: new Date().toISOString(), mode: "production", checked: "静态检查未发现开发Mock、源映射、常见凭据模式及服务端模块标记；不替代完整安全审计", files }, null, 2) + "\n", "utf8");
console.log(`Current verified release: ${output}`);
