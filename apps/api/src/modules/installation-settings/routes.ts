import type { FastifyInstance, FastifyRequest } from "fastify";
import type { SaveOssSettingsRequest, SaveSmtpSettingsRequest, TestMailSettingsRequest, TestOssSettingsRequest } from "@online-video/shared";
import type { InstallationSettingsService } from "./service.js";

export function registerInstallationSettingsModule(app: FastifyInstance, service: InstallationSettingsService,
  access: (request: FastifyRequest, mutation: boolean) => Promise<{ ownerId: string; setup: boolean }>): void {
  const version = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
  const text = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
  const body = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, properties, required });
  app.get("/api/installation/settings", async request => { await access(request, false); return { data: service.getSummary() }; });
  app.put<{ Body: SaveOssSettingsRequest }>("/api/installation/oss", { bodyLimit: 16_384, schema: { body: body({ version,
    accessKeyId: { type: "string", maxLength: 512 }, accessKeySecret: { type: "string", maxLength: 2048 }, bucket: text(63), region: text(64),
    network: { type: "string", enum: ["public", "internal"] }, allowPublicNetwork: { type: "boolean" }, mediaBaseUrl: text(2048), objectPrefix: text(256),
    roleArn: { type: "string", maxLength: 2048 } }, ["version", "bucket", "region", "network", "allowPublicNetwork", "mediaBaseUrl", "objectPrefix"]) } },
  async request => { await access(request, true); return { data: service.saveOss(request.body) }; });
  app.put<{ Body: SaveSmtpSettingsRequest }>("/api/installation/mail", { bodyLimit: 8192, schema: { body: body({ version,
    providerCode: { type: "string", enum: ["qq", "163"] }, host: text(253), port: { type: "integer", minimum: 1, maximum: 65535 }, secure: { type: "boolean" },
    user: text(512), password: { type: "string", maxLength: 4096 }, from: text(512), timeoutMs: { type: "integer", minimum: 1, maximum: 60_000 } },
  ["version", "providerCode", "host", "port", "secure", "user", "from"]) } }, async request => { await access(request, true); return { data: service.saveMail(request.body) }; });
  app.post<{ Body: TestOssSettingsRequest }>("/api/installation/oss/test", { bodyLimit: 1024, schema: { body: body({ version }) } },
    async request => { const principal = await access(request, true); return { data: await service.testOss(request.body.version, principal.ownerId) }; });
  app.post<{ Body: TestMailSettingsRequest }>("/api/installation/mail/test", { bodyLimit: 2048, schema: { body: body({ version,
    providerCode: { type: "string", enum: ["qq", "163"] }, to: text(254) }) } },
  async request => { const principal = await access(request, true); return { data: await service.testMail(request.body, principal.ownerId) }; });
}
