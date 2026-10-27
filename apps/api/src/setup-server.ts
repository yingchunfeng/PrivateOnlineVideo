import { ConfigurationError } from "./core/config.js";
import { readDeploymentTarget } from "./core/deployment-config.js";
import { readInstallationConfig, buildInstallationApp } from "./core/installation-runtime.js";
import { openDatabase } from "./db/database.js";
import { readAuthSettings } from "./modules/auth/settings.js";
import { initializeInstallation } from "./modules/setup/bootstrap.js";
import { hasOnboardingSchema } from "./modules/auth/login-mode.js";

// 与旧 server.ts 分离；不加载工作区 .env，不自动迁移或覆盖既有库。
try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log("默认：npm run dev:api，读取 config/deployment.json 的 databasePath 和可选 authKeyFile，不读取 .env。\n显式入口：npm run dev:setup -w @online-video/api -- --database <项目.local内的.db> [--key-file <已有.auth.key>]；也支持 --config <配置.json>。\n指定 authKeyFile/--key-file 时只复用已有密钥；不指定时使用数据库伴随密钥，新空库才自动生成。已初始化库必须匹配原密钥。\n新空库先完整执行 docs/sql/NEW_INSTALL_FULL.sql。默认端口3000；API_PORT/API_HOST/AUTH_ALLOWED_ORIGINS/NODE_ENV 为基础设施环境变量。切库说明：docs/DATABASE_SWITCHING.md。");
  } else {
    const target = readDeploymentTarget(args);
    const { databasePath } = target;
    const config = readInstallationConfig();
    const settings = readAuthSettings(config.environment, { ...process.env, DATABASE_PATH: databasePath, AUTH_KEY_FILE: target.keyFile });
    const database = openDatabase(databasePath);
    let app;
    try {
      if (!hasOnboardingSchema(database)) throw new ConfigurationError("新部署入口要求完整 v6 新库，旧库请继续用原启动方式；不会自动升级");
      const { key, installationCodeFile } = await initializeInstallation(database, settings, { reuseExistingKey: target.reuseExistingKey });
      const runtime = await buildInstallationApp({ database, key, settings, config, onClose: () => { database.close(); } });
      app = runtime.app;
      await app.listen({ host: config.host, port: config.port });
      if (installationCodeFile) console.log(`首次安装码已写入受保护文件：${installationCodeFile}。请在服务器本机查看，勿提交到仓库或公开分享。`);
    } catch (error) { if (app) await app.close(); if (database.client.open) database.close(); throw error; }
    for (const signal of ["SIGINT", "SIGTERM", ...(process.platform === "win32" ? ["SIGBREAK"] : [])] as NodeJS.Signals[]) {
      process.once(signal, () => { void app!.close().then(() => { process.exitCode = 0; }).catch(() => { process.exitCode = 1; }); });
    }
  }
} catch (error) {
  console.error(error instanceof ConfigurationError ? error.message : "新部署启动失败；请核查新库结构、独立资料路径和端口，原数据及安装资料均保留。");
  process.exitCode = 1;
}
