import type { FastifyInstance } from "fastify";
import type { SetupLoginRequest, SetupPasswordRequest } from "@online-video/shared";
import { HttpError } from "../../core/errors.js";
import { SetupService } from "./service.js";

export interface SetupRouteOptions { validateConfiguration?: (() => Promise<void>) | undefined; onCompleted?: (() => Promise<void>) | undefined }
/** Cookie 插件由应用统一注册，避免与正常认证路由重复装饰。 */
export function registerSetupModule(app: FastifyInstance, service: SetupService, options: SetupRouteOptions = {}): void {
  app.register(async scope => {
    const cookieOptions = { path: "/", httpOnly: true, secure: service.settings.secureCookie, sameSite: "strict" as const };
    const password = { type: "string", minLength: 1, maxLength: 512 };
    scope.addHook("preValidation", async request => {
      const schema = request.routeOptions.schema?.body as { properties?: Record<string, unknown> } | undefined;
      if (schema?.properties && request.body && typeof request.body === "object" && !Array.isArray(request.body) &&
        Object.keys(request.body).some(key => !Object.hasOwn(schema.properties!, key))) throw new HttpError("VALIDATION_ERROR");
    });
    scope.get("/api/setup/status", async request => ({ data: service.status(request) }));
    scope.post<{ Body: SetupLoginRequest }>("/api/setup/login", { bodyLimit: 8192, schema: { body: { type: "object", additionalProperties: false,
      required: ["password"], properties: { password, installationCode: { type: "string", maxLength: 128 } } } } }, async (request, reply) => {
      const result = await service.login(request, request.body);
      reply.setCookie(service.cookieName, result.token, { ...cookieOptions, expires: new Date(result.expiresAt), maxAge: service.sessionTtlMs / 1000 });
      return { data: result.data };
    });
    scope.post<{ Body: SetupPasswordRequest }>("/api/setup/password", { bodyLimit: 8192, schema: { body: { type: "object", additionalProperties: false,
      required: ["newPassword", "confirmPassword"], properties: { newPassword: password, confirmPassword: password } } } }, async (request, reply) => {
      const result = await service.password(request, request.body);
      reply.setCookie(service.cookieName, result.token, { ...cookieOptions, expires: new Date(result.expiresAt), maxAge: service.sessionTtlMs / 1000 });
      return { data: result.data };
    });
    scope.post("/api/setup/complete", { bodyLimit: 1024, schema: { body: { type: "object", additionalProperties: false, properties: {} } } }, async (request, reply) => {
      const result = await service.complete(request, options.validateConfiguration ?? (async () => { throw new HttpError("OSS_CONFIG_REQUIRED"); }));
      reply.clearCookie(service.cookieName, cookieOptions);
      await options.onCompleted?.();
      return { data: result };
    });
    scope.post("/api/setup/logout", async (request, reply) => {
      const result = service.logout(request); reply.clearCookie(service.cookieName, cookieOptions); return { data: result };
    });
  });
}
