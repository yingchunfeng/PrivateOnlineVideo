import cookie from "@fastify/cookie";
import type { FastifyInstance } from "fastify";
import type { LoginRequest, LoginCodeRequest, BindEmailRequest, BindEmailConfirmRequest, PasswordCodeRequest, ChangePasswordRequest,
  ChangeEmailRequest, VerifyOldEmailRequest, AccountOperationRequest, ChangeEmailConfirmRequest } from "@online-video/shared";
import { AuthService } from "./service.js";
import { HttpError } from "../../core/errors.js";

export function registerAuthModule(app: FastifyInstance, service: AuthService): void {
  app.register(cookie);
  app.register(async scope => {
    const cookieOptions = { path: "/", httpOnly: true, secure: service.settings.secureCookie, sameSite: "strict" as const };
    const password = { type: "string", minLength: 1, maxLength: 512 };
    const code = { type: "string", pattern: "^[0-9]{6}$" };
    const id = { type: "string", minLength: 1, maxLength: 128 };
    const email = { type: "string", minLength: 3, maxLength: 254 };
    const body = (properties: Record<string, object>, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, required, properties });
    const operation = { operationId: id, challengeId: id, code };
    // 在 AJV 移除额外字段之前拒绝它们，防止发码接口接受调用方收件地址。
    scope.addHook("preValidation", async request => {
      const schema = request.routeOptions.schema?.body as { properties?: Record<string, unknown> } | undefined;
      if (schema?.properties && request.body && typeof request.body === "object" && !Array.isArray(request.body) &&
        Object.keys(request.body).some(key => !Object.hasOwn(schema.properties!, key))) throw new HttpError("VALIDATION_ERROR");
    });
    scope.get("/api/auth/login/options", async () => ({ data: service.loginOptions() }));
    scope.post<{ Body: LoginCodeRequest }>("/api/auth/login/code", { bodyLimit: 8192, schema: { body: body({ password }) } },
      async request => ({ data: await service.requestLoginCode(request, request.body) }));
    scope.post<{ Body: LoginRequest }>("/api/auth/login", { bodyLimit: 8192, schema: { body: {
      ...body({ password, totp: code, authMethod: { type: "string", enum: ["totp", "email"] }, challengeId: id, code }, ["password"]),
      if: { properties: { authMethod: { const: "email" } }, required: ["authMethod"] },
      then: { required: ["authMethod", "challengeId", "code"], not: { required: ["totp"] } },
      else: { required: ["totp"], not: { anyOf: [{ required: ["challengeId"] }, { required: ["code"] }] } }
    } } }, async (request, reply) => {
      const result = await service.login(request, request.body);
      reply.setCookie(service.cookieName, result.token, { ...cookieOptions, expires: new Date(result.expiresAt), maxAge: Math.floor(service.settings.sessionTtlMs / 1000) });
      return { data: result.data };
    });
    scope.get("/api/auth/me", async request => ({ data: await service.me(request) }));
    scope.get("/api/auth/security", async request => ({ data: await service.security(request) }));
    scope.post<{ Body: BindEmailRequest }>("/api/auth/email/bind/code", { bodyLimit: 8192, schema: { body: body({ currentPassword: password, totp: code, email }) } },
      async request => ({ data: await service.bindEmailRequest(request, request.body) }));
    scope.post<{ Body: BindEmailConfirmRequest }>("/api/auth/email/bind/confirm", { bodyLimit: 8192, schema: { body: body({ currentPassword: password, totp: code, ...operation }) } },
      async (request, reply) => { const data = await service.bindEmailConfirm(request, request.body); reply.clearCookie(service.cookieName, cookieOptions); return { data }; });
    scope.post<{ Body: PasswordCodeRequest }>("/api/auth/password/code", { bodyLimit: 8192, schema: { body: body({ currentPassword: password }) } },
      async request => ({ data: await service.passwordRequest(request, request.body) }));
    scope.post<{ Body: ChangePasswordRequest }>("/api/auth/password/confirm", { bodyLimit: 8192, schema: { body: body({ currentPassword: password, newPassword: password, confirmPassword: password, ...operation }) } },
      async (request, reply) => { const data = await service.passwordConfirm(request, request.body); reply.clearCookie(service.cookieName, cookieOptions); return { data }; });
    scope.post<{ Body: ChangeEmailRequest }>("/api/auth/email/change/old/code", { bodyLimit: 8192, schema: { body: body({ currentPassword: password, newEmail: email }) } },
      async request => ({ data: await service.emailChangeRequest(request, request.body) }));
    scope.post<{ Body: VerifyOldEmailRequest }>("/api/auth/email/change/old/verify", { bodyLimit: 8192, schema: { body: body({ currentPassword: password, ...operation }) } },
      async request => ({ data: await service.emailChangeVerifyOld(request, request.body) }));
    scope.post<{ Body: AccountOperationRequest }>("/api/auth/email/change/new/code", { bodyLimit: 8192, schema: { body: body({ operationId: id }) } },
      async request => ({ data: await service.emailChangeRequestNew(request, request.body) }));
    scope.post<{ Body: ChangeEmailConfirmRequest }>("/api/auth/email/change/confirm", { bodyLimit: 8192, schema: { body: body({ currentPassword: password, ...operation }) } },
      async (request, reply) => { const data = await service.emailChangeConfirm(request, request.body); reply.clearCookie(service.cookieName, cookieOptions); return { data }; });
    scope.post<{ Body: AccountOperationRequest }>("/api/auth/operations/cancel", { bodyLimit: 8192, schema: { body: body({ operationId: id }) } },
      async request => ({ data: await service.cancelOperation(request, request.body) }));
    scope.get("/api/auth/sessions", async request => ({ data: await service.sessions(request) }));
    scope.post("/api/auth/logout", async (request, reply) => { await service.revoke(request); reply.clearCookie(service.cookieName, cookieOptions); return { data: { success: true } }; });
    scope.post<{ Params: { sessionId: string } }>("/api/auth/sessions/:sessionId/revoke", async (request, reply) => {
      const current = await service.requireUser(request, { mutation: true });
      await service.revoke(request, request.params.sessionId);
      if (current.loginSessionId === request.params.sessionId) reply.clearCookie(service.cookieName, cookieOptions);
      return { data: { success: true } };
    });
  });
}
