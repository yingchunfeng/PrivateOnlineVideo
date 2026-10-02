import type { AppConfig } from "./config.js";
import { ConfigurationError } from "./config.js";
import { buildApp } from "../app.js";
import type { BuildAppOptions } from "../app.js";

export async function startServer(config: AppConfig, options: Omit<BuildAppOptions, "config"> = {}) {
  const app = await buildApp({ ...options, config });
  try { await app.listen({ host: config.host, port: config.port }); }
  catch (error) {
    await app.close();
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new ConfigurationError(`监听地址 ${config.host}:${config.port} 已被占用。请检查占用进程或明确调整 API_PORT；不会终止进程或自动换端口`);
    }
    throw new ConfigurationError("API 监听失败，请检查监听地址和运行权限");
  }
  return app;
}
