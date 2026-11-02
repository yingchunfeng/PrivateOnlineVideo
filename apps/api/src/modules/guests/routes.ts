import type { FastifyInstance, FastifyRequest } from "fastify";
import type { CreateGuestRequest, UpdateGuestRequest } from "@online-video/shared";
import { AuthService } from "../auth/service.js";
import { HttpError } from "../../core/errors.js";

export function registerGuestModule(app: FastifyInstance, auth: AuthService): void {
  app.register(async scope => {
    const admin = async (request: FastifyRequest, mutation: boolean) => {
      const principal = await auth.requireUser(request, { mutation });
      if (principal.guest || principal.user.role === "guest") throw new HttpError("FORBIDDEN");
      return principal.user.id;
    };
    const fields = { name: { type: "string", minLength: 1, maxLength: 40 }, expiresAt: { type: "string", minLength: 20, maxLength: 40 },
      permissions: { type: "array", minItems: 1, maxItems: 7, uniqueItems: true, items: { type: "string", enum: ["library", "upload", "pages", "tasks", "configuration", "video_edit", "video_delete"] } } };
    const version = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
    const body = (properties: Record<string, object>) => ({ type: "object", additionalProperties: false, properties, required: Object.keys(properties) });
    scope.addHook("preValidation", async request => {
      const schema = request.routeOptions.schema?.body as { properties?: Record<string, unknown> } | undefined;
      if (schema?.properties && request.body && typeof request.body === "object" && !Array.isArray(request.body) &&
        Object.keys(request.body).some(key => !Object.hasOwn(schema.properties!, key))) throw new HttpError("VALIDATION_ERROR");
    });
    scope.get("/api/guests", async request => ({ data: auth.guests.list(await admin(request, false)) }));
    scope.post<{ Body: CreateGuestRequest }>("/api/guests", { bodyLimit: 8192, schema: { body: body(fields) } }, async request => {
      const ownerId = await admin(request, true);
      return { data: await auth.guests.create(ownerId, request.body, () => admin(request, true)) };
    });
    scope.patch<{ Params: { guestId: string }; Body: UpdateGuestRequest }>("/api/guests/:guestId", { bodyLimit: 8192, schema: { body: body({ ...fields, version }) } },
      async request => ({ data: auth.guests.update(await admin(request, true), request.params.guestId, request.body) }));
    scope.post<{ Params: { guestId: string }; Body: { version: number } }>("/api/guests/:guestId/reset", { bodyLimit: 1024, schema: { body: body({ version }) } }, async request => {
      const ownerId = await admin(request, true);
      return { data: await auth.guests.reset(ownerId, request.params.guestId, request.body.version, () => admin(request, true)) };
    });
    scope.post<{ Params: { guestId: string }; Body: { version: number } }>("/api/guests/:guestId/revoke", { bodyLimit: 1024, schema: { body: body({ version }) } },
      async request => ({ data: auth.guests.revoke(await admin(request, true), request.params.guestId, request.body.version) }));
  });
}
