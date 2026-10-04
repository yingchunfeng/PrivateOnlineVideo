import { readConfig } from "../src/core/config.js";
import { loadRuntimeAuth } from "../src/modules/auth/runtime.js";
import { runtimeModules } from "../src/core/runtime.js";
import { buildApp } from "../src/app.js";

// 实际验收入口：沿用原账号和正式库，不初始化、迁移、清理或修改云策略。
process.env.DEBUG = "";
const sitePortIndex = process.argv.indexOf("--site-port");
const sitePort = sitePortIndex < 0 ? "5173" : process.argv[sitePortIndex + 1];
if (!["5173", "5174"].includes(sitePort ?? "")) throw new Error("REAL_ACCEPTANCE_SITE_PORT_MISMATCH");
if (sitePort === "5174") process.env.AUTH_ALLOWED_ORIGINS = `${process.env.AUTH_ALLOWED_ORIGINS ?? "http://127.0.0.1:5173,http://127.0.0.1:3000"},http://127.0.0.1:5174`;
const config = readConfig();
const apiPortIndex = process.argv.indexOf("--api-port");
const apiPort = apiPortIndex < 0 ? config.port : Number(process.argv[apiPortIndex + 1]);
if (![3000, 3010, 3011].includes(apiPort)) throw new Error("REAL_ACCEPTANCE_API_PORT_MISMATCH");
if (config.host !== "127.0.0.1" || config.storageDriver !== "oss" || config.oss?.bucket !== "xzlbucket") {
  throw new Error("REAL_ACCEPTANCE_TARGET_MISMATCH");
}
const runtime = await loadRuntimeAuth(config);
let app: Awaited<ReturnType<typeof buildApp>>;
try {
  app = await buildApp({ config, auth: runtime.service, ...await runtimeModules(config, runtime.service, runtime.database),
    logger: false, onClose: () => { runtime.database.close(); } });
  await app.listen({ host: config.host, port: apiPort });
  console.log(JSON.stringify({ state: "simple-oss-api-ready", origin: `http://127.0.0.1:${apiPort}`, mock: false }));
} catch (error) {
  if (runtime.database.client.open) runtime.database.close();
  console.error(error instanceof Error && error.name === "ConfigurationError" ? error.message : "REAL_ACCEPTANCE_START_FAILED");
  process.exit(1);
}
let closing = false;
async function close() {
  if (closing) return; closing = true;
  await app.close(); console.log("simple-oss-api-closed"); process.exit(0);
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", value => { if (String(value).trim() === "shutdown") void close(); });
for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) process.once(signal, () => { void close(); });
