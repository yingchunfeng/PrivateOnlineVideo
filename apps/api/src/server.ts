import { readConfig, ConfigurationError } from "./core/config.js";
import { startServer } from "./core/start.js";
import { loadRuntimeAuth } from "./modules/auth/runtime.js";
import { runtimeModules } from "./core/runtime.js";

try {
  const config = readConfig();
  const runtime = await loadRuntimeAuth(config);
  let app;
  try { app = await startServer(config, { auth: runtime.service, ...await runtimeModules(config, runtime.service, runtime.database), onClose: () => { runtime.database.close(); } }); }
  catch (error) { if (runtime.database.client.open) runtime.database.close(); throw error; }
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  if (process.platform === "win32") signals.push("SIGBREAK");
  for (const signal of signals) {
    process.once(signal, () => {
      void app.close().then(() => { process.exitCode = 0; }).catch(() => { process.exitCode = 1; });
    });
  }
} catch (error) {
  console.error(error instanceof ConfigurationError ? error.message : "API 启动失败，请检查模块注册配置");
  process.exitCode = 1;
}
