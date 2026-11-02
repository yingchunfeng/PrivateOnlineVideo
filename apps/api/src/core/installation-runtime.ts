import { closeSync, constants, copyFileSync, existsSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { LibraryConfig } from "@online-video/shared";
import type { AppConfig } from "./config.js";
import { ConfigurationError, readConfig } from "./config.js";
import { HttpError } from "./errors.js";
import { buildApp } from "../app.js";
import type { AppDatabase } from "../db/database.js";
import { guardLocalFile } from "../db/database.js";
import { createRepositories } from "../db/repositories.js";
import { AuthService } from "../modules/auth/service.js";
import type { AuthSettings } from "../modules/auth/settings.js";
import { SetupService } from "../modules/setup/service.js";
import { InstallationSettingsService } from "../modules/installation-settings/service.js";
import { createMediaModule, UnavailableMetadataInspector } from "../modules/media/index.js";
import { createSiteSettings } from "../modules/site-settings/service.js";
import { loadLibraryConfig, validateLibraryConfig } from "./library-config.js";
import { recoverLibraryConfiguration } from "./library-configuration.js";

/** 新入口只读取基础设施环境变量，不加载旧 .env 或个人 OSS/媒体配置。 */
export function readInstallationConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const base = readConfig({ NODE_ENV: "development", API_HOST: env.API_HOST ?? "127.0.0.1", API_PORT: env.API_PORT ?? "3000",
    LOG_LEVEL: env.LOG_LEVEL ?? "info", TRUSTED_PROXIES: env.TRUSTED_PROXIES,
    MAX_UPLOAD_BYTES: "2147483648", UPLOAD_PART_SIZE_BYTES: "8388608", MAX_UPLOAD_CONCURRENCY: "2", MEDIA_REQUESTS_PER_MINUTE: "120" });
  const environment = env.NODE_ENV ?? "development";
  if (!["development", "test", "production"].includes(environment)) throw new ConfigurationError("NODE_ENV 只允许 development、test、production");
  return { ...base, environment: environment as AppConfig["environment"], installationMode: true, libraryMode: "public", storageDriver: "oss", playbackMode: "oss",
    usageTimezone: "UTC", media: { ...base.media!, objectPrefix: "onlineVideo/" }, oss: null,
    library: { mediaBaseUrl: "https://unconfigured.invalid", objectPrefix: "onlineVideo/", categories: [] } };
}

export interface InstallationRuntimeOptions {
  database: AppDatabase; key: Buffer; settings: AuthSettings; config: AppConfig;
  settingsOptions?: ConstructorParameters<typeof InstallationSettingsService>[2];
  logger?: boolean;
  onClose?: () => void | Promise<void>;
}

export async function buildInstallationApp(options: InstallationRuntimeOptions) {
  const { database, key, settings, config } = options;
  if (!config.installationMode || !config.library || !config.media) throw new ConfigurationError("新部署运行配置不完整");
  let setup: SetupService;
  const installation = new InstallationSettingsService(database, key, { ...options.settingsOptions, isReady: () => setup?.isReady() ?? false });
  const auth = new AuthService(database, key, settings, options.settingsOptions?.now, installation.createMailSender());
  auth.setMailConfigurationCheck(email => installation.hasTestedMail(email));
  setup = new SetupService(database, key, settings, auth, options.settingsOptions?.now);
  const libraryPath = guardLocalFile(`${settings.databasePath}.library.json`);
  config.libraryConfigPath = libraryPath;
  const initialLibrary = (mediaBaseUrl: string, objectPrefix: string): LibraryConfig => {
    const row = database.client.prepare("SELECT id,name FROM categories WHERE is_default=1").get() as { id: string; name: string } | undefined;
    if (!row) throw new ConfigurationError("首次安装缺少默认分类");
    return validateLibraryConfig({ mediaBaseUrl, objectPrefix, categories: [{ id: row.id, name: row.name, tags: [] }] });
  };
  const writeInitialLibrary = (library: LibraryConfig, replacing = false) => {
    const path = replacing ? `${libraryPath}.setup-${randomUUID()}.tmp` : libraryPath;
    if (replacing) copyFileSync(libraryPath, `${libraryPath}.before-setup-${randomUUID()}.backup.json`, constants.COPYFILE_EXCL);
    const file = openSync(path, "wx", 0o600);
    try { writeFileSync(file, JSON.stringify(library, null, 2) + "\n", "utf8"); fsyncSync(file); } finally { closeSync(file); }
    if (replacing) renameSync(path, libraryPath);
  };
  const prepareBusiness = async () => {
    const oss = installation.readOssSettings();
    if (!oss || (!setup.isReady() && !installation.hasTestedOss())) throw new HttpError("OSS_CONFIG_REQUIRED");
    let library: LibraryConfig;
    if (existsSync(libraryPath)) {
      recoverLibraryConfiguration(database, libraryPath);
      library = loadLibraryConfig(libraryPath);
      if (library.mediaBaseUrl !== oss.mediaBaseUrl || library.objectPrefix !== oss.objectPrefix) {
        // 完成步骤被并发设置打断时，只重试本向导生成的原始空库配置；不覆盖业务配置。
        const pristine = initialLibrary(library.mediaBaseUrl, library.objectPrefix);
        const records = database.client.prepare("SELECT (SELECT count(*) FROM videos)+(SELECT count(*) FROM upload_tasks) n").get() as { n: number };
        if (setup.isReady() || records.n !== 0 || JSON.stringify(library) !== JSON.stringify(pristine)) throw new ConfigurationError("数据库伴随媒体配置与 OSS 定位不一致；保留现有文件，请核查配置");
        library = initialLibrary(oss.mediaBaseUrl, oss.objectPrefix); writeInitialLibrary(library, true);
      }
    } else {
      if (setup.isReady()) throw new ConfigurationError("已完成安装的数据库缺少分类配置文件；不会重新生成覆盖历史分类");
      library = initialLibrary(oss.mediaBaseUrl, oss.objectPrefix); writeInitialLibrary(library);
    }
    Object.assign(config.library!, library);
    config.media!.objectPrefix = oss.objectPrefix;
    Object.assign(config, { oss: { bucket: oss.bucket, region: oss.region, endpoint: oss.endpoint, playbackEndpoint: oss.mediaBaseUrl,
      network: oss.network, allowPublicNetwork: oss.allowPublicNetwork, credentialFile: "", ...(oss.roleArn ? { roleArn: oss.roleArn } : {}),
      stsDurationSeconds: 3600, stsRefreshBeforeSeconds: 300, signedUrlTtlSeconds: 3600, clockSkewSeconds: 30 } });
  };
  if (setup.isReady()) await prepareBusiness();
  const repositories = createRepositories(database, options.settingsOptions?.now, config.library);
  const storage = installation.createStorage();
  const app = await buildApp({ config, ...(options.logger === undefined ? {} : { logger: options.logger }), auth, setup, installationSettings: installation,
    validateInstallation: prepareBusiness,
    backend: { database, auth, config },
    media: { register: createMediaModule({ ...config.media, metadata: new UnavailableMetadataInspector(), getMaxUploadBytes: () => createSiteSettings(database, config).view().maxUploadBytes }),
      dependencies: { kind: config.environment === "production" ? "production" : "development", config, auth, ...repositories, storage, now: options.settingsOptions?.now ?? (() => new Date()) } },
    ...(options.onClose ? { onClose: options.onClose } : {}) });
  return { app, auth, setup, installation };
}
