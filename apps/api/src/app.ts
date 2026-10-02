import { randomUUID } from "node:crypto";
import Fastify, { LogController } from "fastify";
import type { HealthResponse } from "@online-video/shared";
import type { AppConfig } from "./core/config.js";
import { ConfigurationError, readConfig } from "./core/config.js";
import { registerErrorHandlers } from "./core/errors.js";
import type { MediaRegistration } from "./core/contracts/index.js";
import { assertMediaDependencies } from "./core/contracts/index.js";
import type { AuthService } from "./modules/auth/service.js";
import { registerAuthModule } from "./modules/auth/routes.js";

export interface BuildAppOptions {
  config?: AppConfig;
  logger?: boolean;
  logStream?: { write(line: string): void };
  media?: MediaRegistration;
  auth?: AuthService;
  onClose?: () => void | Promise<void>;
}
/** 只构建应用，不监听端口；后续业务模块由此统一装配。 */
export async function buildApp(options: BuildAppOptions = {}) {
  const config = options.config ?? readConfig();
  if (config.environment === "production") {
    throw new ConfigurationError("生产安全模块尚未交付，CORE-01 拒绝生产装配");
  }
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
  if (options.media) {
    try { await options.media.register(app, options.media.dependencies); }
    catch (error) { await app.close(); throw error; }
  }
  return app;
}
