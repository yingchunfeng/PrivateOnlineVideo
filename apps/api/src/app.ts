import { randomUUID } from "node:crypto";
import Fastify, { LogController } from "fastify";
import type { HealthResponse } from "@online-video/shared";
import type { AppConfig } from "./core/config.js";
import { ConfigurationError, readConfig } from "./core/config.js";
import { registerErrorHandlers } from "./core/errors.js";
import type { MediaRegistration } from "./core/contracts/index.js";
import { assertMediaDependencies } from "./core/contracts/index.js";
import { AuthService } from "./modules/auth/service.js";
import { registerAuthModule } from "./modules/auth/routes.js";
import { registerBackendModule } from "./modules/catalog/routes.js";
import type { BackendDependencies } from "./modules/catalog/routes.js";
import { registerProgressModule } from "./modules/progress/routes.js";

export interface BuildAppOptions {
  config?: AppConfig;
  logger?: boolean;
  logStream?: { write(line: string): void };
  media?: MediaRegistration;
  auth?: AuthService;
  backend?: BackendDependencies;
  onClose?: () => void | Promise<void>;
}
/** 只构建应用，不监听端口；后续业务模块由此统一装配。 */
export async function buildApp(options: BuildAppOptions = {}) {
  const config = options.config ?? readConfig();
  if (config.environment === "production" && (!options.auth || !options.backend || !options.media || options.media.dependencies.auth !== options.auth || options.backend.auth !== options.auth)) throw new ConfigurationError("生产必须装配真实鉴权、SQL和媒体模块");
  if (config.environment === "production" && (!(options.auth instanceof AuthService) || options.auth.database !== options.backend!.database || !options.auth.settings.secureCookie || options.auth.settings.allowedOrigins.some(origin => !origin.startsWith("https://")))) throw new ConfigurationError("生产必须使用同一SQLite的真实AuthService、安全Cookie和HTTPS Origin");
  if (options.backend && (options.backend.config !== config || (options.auth && options.backend.auth !== options.auth))) throw new ConfigurationError("后端模块必须复用应用配置及真实AuthGuard");
  if (options.media) assertMediaDependencies(config, options.media);
  const app = Fastify({
    logger: options.logger === false ? false : {
      level: config.logLevel,
      ...(options.logStream ? { stream: options.logStream } : {}),
      // 不序列化整个 request、错误对象或请求体，避免 Cookie、查询串和凭证泄漏。
      redact: ["req.headers.cookie", "req.headers.authorization", "req.headers.x-csrf-token", "res.headers.set-cookie"]
    },
    logController: new LogController({ disableRequestLogging: true }),
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    trustProxy: config.trustedProxies.length ? config.trustedProxies : false,
    bodyLimit: 1024 * 1024,
    requestTimeout: 120_000
  });
  registerErrorHandlers(app);
  if (options.onClose) app.addHook("onClose", async () => { await options.onClose!(); });
  app.addHook("onRequest", async (_request, reply) => { reply.header("cache-control", "no-store"); });
  app.addHook("onResponse", async (request, reply) => {
    request.log.info({ method: request.method, route: request.routeOptions.url ?? "unmatched",
      statusCode: reply.statusCode, responseTimeMs: reply.elapsedTime }, "request completed");
  });
  app.get<{ Reply: HealthResponse }>("/api/health", {
    schema: { response: { 200: {
      type: "object", additionalProperties: false, required: ["data"],
      properties: { data: { type: "object", additionalProperties: false, required: ["status"],
        properties: { status: { type: "string", const: "ok" } } } }
    } } }
  }, async () => ({ data: { status: "ok" } }));
  if (options.auth) registerAuthModule(app, options.auth);
  if (options.backend) { await registerBackendModule(app, options.backend); registerProgressModule(app, options.backend); }
  if (options.media) {
    try { await options.media.register(app, options.media.dependencies); }
    catch (error) { await app.close(); throw error; }
  }
  return app;
}
