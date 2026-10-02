import cookie from "@fastify/cookie";
import type { FastifyInstance } from "fastify";
import type { LoginRequest } from "@online-video/shared";
import { AuthService } from "./service.js";

export function registerAuthModule(app: FastifyInstance, service: AuthService): void {
  app.register(cookie);
  app.register(async scope => {
    const cookieOptions = { path: "/", httpOnly: true, secure: service.settings.secureCookie, sameSite: "strict" as const };
    scope.post<{ Body: LoginRequest }>("/api/auth/login", { bodyLimit: 8192, schema: { body: {
      type: "object", additionalProperties: false, required: ["password", "totp"], properties: {
        password: { type: "string", minLength: 1, maxLength: 512 }, totp: { type: "string", pattern: "^[0-9]{6}$" }
      }
    } } }, async (request, reply) => {
      const result = await service.login(request, request.body);
      reply.setCookie(service.cookieName, result.token, { ...cookieOptions, expires: new Date(result.expiresAt), maxAge: Math.floor(service.settings.sessionTtlMs / 1000) });
      return { data: result.data };
    });
    scope.get("/api/auth/me", async request => ({ data: await service.me(request) }));
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
