import { build } from "vite";
import { createHash } from "node:crypto";
import { access, readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

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
    if (name.endsWith(".map") || /mock|fixtures/i.test(name)) throw new Error(`独立发布目录含开发产物：${name}`);
    const text = content.toString("utf8");
    for (const marker of ["demo-password", "mock-owner", "ov.dev-mock", "devMock=1", "AccessKey", "totpSecret", "account-setup.json", "auth.key", "better-sqlite3", "ali-oss", "node:crypto", "node:fs", "SMTP_CONFIG_FILE", "smtp.json", "nodemailer", "mock-password", "MockMailSender"]) if (text.includes(marker)) throw new Error(`独立发布产物含禁止标记：${marker}`);
    files.push({ path: name, bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") });
  }
}
await inspect(output);
await writeFile(join(output, "manifest.json"), JSON.stringify({ createdAt: new Date().toISOString(), mode: "production", checked: "全目录无开发Mock、长期凭证、数据库及Node模块引用", files }, null, 2) + "\n", "utf8");
console.log(`Current verified release: ${output}`);
