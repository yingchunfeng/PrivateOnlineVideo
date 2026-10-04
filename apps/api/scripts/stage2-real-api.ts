import { readConfig } from "../src/core/config.js";
import { loadRuntimeAuth } from "../src/modules/auth/runtime.js";
import { runtimeModules } from "../src/core/runtime.js";
import { buildApp } from "../src/app.js";

process.env.DEBUG = "";
const normalConfig = readConfig();
// 仅验收过程临时请求15分钟STS，验证真实短剩余凭据和5分钟前续签；不修改.env或角色配置。
const config = process.argv.includes("--short-sts") ? { ...normalConfig,
  oss: normalConfig.oss ? { ...normalConfig.oss, stsDurationSeconds: 900 } : null } : normalConfig;
if (config.host !== "127.0.0.1" || config.port !== 3000 || config.oss?.bucket !== "xzlbucket" ||
  config.media?.uploadObjectPrefix !== (process.argv.includes("--normal") ? "onlineVideo/originals/" : "onlineVideo/acceptance/local/20261002-ces-private/")) throw new Error("Acceptance API target mismatch");
const runtime = await loadRuntimeAuth(config);
let app: Awaited<ReturnType<typeof buildApp>>;
try {
  app = await buildApp({ config, auth: runtime.service, ...await runtimeModules(config, runtime.service, runtime.database),
    logger: false, onClose: () => runtime.database.close() });
  await app.listen({ host: config.host, port: config.port });
  console.log(JSON.stringify({ state: "acceptance-api-ready", origin: "http://127.0.0.1:3000", driver: "oss", mock: false,
    requestedStsSeconds: config.oss!.stsDurationSeconds, temporaryShortStsProfile: process.argv.includes("--short-sts") }));
} catch {
  if (runtime.database.client.open) runtime.database.close();
  console.error("Acceptance API startup failed"); process.exit(1);
}
let closing = false;
async function close() { if (closing) return; closing = true; await app.close(); console.log("Acceptance API closed"); process.exit(0); }
process.stdin.setEncoding("utf8");
process.stdin.on("data", text => { if (String(text).trim() === "shutdown") void close(); });
for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) process.once(signal, () => { void close(); });
