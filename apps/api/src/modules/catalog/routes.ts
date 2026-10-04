import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../core/config.js";
import type { AuthGuard } from "../../core/contracts/index.js";
import type { AppDatabase } from "../../db/database.js";
import { createRepositories } from "../../db/repositories.js";
import { HttpError } from "../../core/errors.js";
import type { VideoListQuery, UpdateVideoRequest } from "@online-video/shared";
import { randomUUID } from "node:crypto";
import { objectKeyFromPublicUrl } from "../../core/library-config.js";
import { createLibraryConfiguration } from "../../core/library-configuration.js";
import type { SaveLibraryConfigurationRequest } from "@online-video/shared";

export interface BackendDependencies { database: AppDatabase; auth: AuthGuard; config: AppConfig; now?: () => Date }
function body(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.keys(value).length || Object.keys(value).some(key => !allowed.includes(key))) throw new HttpError("VALIDATION_ERROR");
  return value as Record<string, unknown>;
}
/** 使用真实SQL和同一AuthGuard；以owner绑定，已有地址仅接受配置媒体域名及授权前缀。 */
export async function registerBackendModule(app: FastifyInstance, deps: BackendDependencies) {
  const repos = createRepositories(deps.database, deps.now ?? (() => new Date()), deps.config.library);
  const configuration = deps.config.library ? createLibraryConfiguration(deps.database, deps.config.library, deps.config.libraryConfigPath, deps.now) : null;
  const editable = (ownerId: string): SaveLibraryConfigurationRequest => {
    const current = configuration!.view(ownerId);
    return { version: current.version, categories: current.categories.map(({ id, name, enabled, tagIds }) => ({ id, name, enabled, tagIds })), tags: current.tags.map(({ id, name, enabled }) => ({ id, name, enabled })) };
  };
  app.get("/api/library/configuration", async request => {
    const auth = await deps.auth.requireUser(request, { mutation: false }); if (!configuration) throw new HttpError("SERVICE_NOT_CONFIGURED");
    return { data: configuration.view(auth.user.id) };
  });
  app.put("/api/library/configuration", async request => {
    const auth = await deps.auth.requireUser(request, { mutation: true }); if (!configuration) throw new HttpError("SERVICE_NOT_CONFIGURED");
    return { data: configuration.save(auth.user.id, request.body as SaveLibraryConfigurationRequest) };
  });
  app.get("/api/library", async request => {
    await deps.auth.requireUser(request, { mutation: false });
    if (!deps.config.library) throw new HttpError("SERVICE_NOT_CONFIGURED");
    configuration!.ensureAvailable();
    const config = deps.config.library;
    return { data: { ...config, categories: config.categories.map(category => {
      const activeIndexes = category.tags.map((name, index) => ({ name, index })).filter(tag => !config.tagDefinitions?.some(definition => definition.name === tag.name && definition.enabled === false));
      return { ...category, tags: activeIndexes.map(tag => tag.name), ...(category.tagIds ? { tagIds: activeIndexes.map(tag => category.tagIds![tag.index]) } : {}) };
    }) } };
  });
  for (const [path, entity, allowed] of [["categories", "categories", ["name", "sortOrder"]], ["groups", "library_groups", ["name", "description", "sortOrder"]], ["tags", "tags", ["name"]]] as const) {
    app.get<{ Querystring: { includeArchived?: string } }>(`/api/${path}`, async request => {
      const auth = await deps.auth.requireUser(request, { mutation: false });
      if (Object.keys(request.query).some(key => key !== "includeArchived") || (request.query.includeArchived !== undefined && !["true", "false"].includes(request.query.includeArchived))) throw new HttpError("VALIDATION_ERROR");
      if (configuration) {
        const current = configuration.view(auth.user.id); const includeArchived = request.query.includeArchived === "true";
        if (entity === "categories") return { data: current.categories.map((category, sortOrder) => ({ ...category, sortOrder, archivedAt: category.enabled ? null : "停用" })).filter(category => includeArchived || category.enabled) };
        if (entity === "tags") return { data: current.tags.filter(tag => includeArchived || tag.enabled).map(tag => ({ ...tag, archivedAt: tag.enabled ? null : "停用" })) };
        throw new HttpError("SERVICE_NOT_CONFIGURED");
      }
      return { data: repos.organizations.list(entity, auth.user.id, request.query.includeArchived === "true") };
    });
    app.post(`/api/${path}`, async request => {
      const auth = await deps.auth.requireUser(request, { mutation: true }); const input = body(request.body, configuration ? [...allowed, "version", "confirmImpact"] : [...allowed]);
      if (typeof input.name !== "string") throw new HttpError("VALIDATION_ERROR");
      if (configuration) {
        if (entity === "library_groups") throw new HttpError("SERVICE_NOT_CONFIGURED");
        const request = editable(auth.user.id); request.version = input.version as string;
        if (entity === "categories") {
          if (input.sortOrder !== undefined && (!Number.isSafeInteger(input.sortOrder) || (input.sortOrder as number) < 0 || (input.sortOrder as number) > request.categories.length)) throw new HttpError("VALIDATION_ERROR");
          request.categories.splice((input.sortOrder as number | undefined) ?? request.categories.length, 0, { name: input.name, enabled: true, tagIds: [] });
        } else request.tags.push({ name: input.name, enabled: true });
        const saved = configuration.save(auth.user.id, { ...request, ...(input.confirmImpact === undefined ? {} : { confirmImpact: input.confirmImpact as boolean }) });
        return { data: (entity === "categories" ? saved.categories : saved.tags).find(item => item.name === (input.name as string).normalize("NFKC").trim()) };
      }
      return { data: repos.organizations.create(entity, auth.user.id, input as { name: string }) };
    });
    app.patch<{ Params: { id: string } }>(`/api/${path}/:id`, async request => {
      const auth = await deps.auth.requireUser(request, { mutation: true }); const input = body(request.body, configuration ? [...allowed, "archived", "version", "confirmImpact"] : [...allowed, "archived"]);
      if (configuration) {
        if (entity === "library_groups") throw new HttpError("SERVICE_NOT_CONFIGURED");
        const desired = editable(auth.user.id); desired.version = input.version as string;
        const items = entity === "categories" ? desired.categories : desired.tags; const item = items.find(item => item.id === request.params.id); if (!item) throw new HttpError("NOT_FOUND");
        if (input.name !== undefined) { if (typeof input.name !== "string") throw new HttpError("VALIDATION_ERROR"); item.name = input.name; }
        if (input.archived !== undefined) { if (typeof input.archived !== "boolean") throw new HttpError("VALIDATION_ERROR"); item.enabled = !input.archived; }
        if (entity === "categories" && input.sortOrder !== undefined) { if (!Number.isSafeInteger(input.sortOrder) || (input.sortOrder as number) < 0 || (input.sortOrder as number) >= items.length) throw new HttpError("VALIDATION_ERROR"); const previous = desired.categories.indexOf(item as typeof desired.categories[number]); desired.categories.splice(previous, 1); desired.categories.splice(input.sortOrder as number, 0, item as typeof desired.categories[number]); }
        const saved = configuration.save(auth.user.id, { ...desired, ...(input.confirmImpact === undefined ? {} : { confirmImpact: input.confirmImpact as boolean }) });
        return { data: (entity === "categories" ? saved.categories : saved.tags).find(item => item.id === request.params.id) };
      }
      return { data: repos.organizations.update(entity, auth.user.id, request.params.id, input) };
    });
  }
  app.get<{ Querystring: Record<string, string> }>("/api/videos", async request => {
    const auth = await deps.auth.requireUser(request, { mutation: false }); const raw = request.query;
    if (Object.keys(raw).some(key => !["page", "pageSize", "categoryId", "groupIds", "tagIds", "tags", "q"].includes(key)) || Object.values(raw).some(value => typeof value !== "string")) throw new HttpError("VALIDATION_ERROR");
    const query: VideoListQuery = { ...raw };
    for (const field of ["page", "pageSize"] as const) if (raw[field] !== undefined) {
      if (!/^\d+$/.test(raw[field])) throw new HttpError("VALIDATION_ERROR"); query[field] = Number(raw[field]);
    }
    return { data: await repos.catalog.list(auth.user.id, query) };
  });
  app.post("/api/videos/register-public", async request => {
    const auth = await deps.auth.requireUser(request, { mutation: true }); const config = deps.config.library;
    if (!config) throw new HttpError("SERVICE_NOT_CONFIGURED");
    const input = body(request.body, ["publicUrl", "title", "categoryId", "tags"]);
    if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 256 || typeof input.categoryId !== "string") throw new HttpError("VALIDATION_ERROR");
    const objectKey = objectKeyFromPublicUrl(config, input.publicUrl);
    const selection = await repos.organizations.normalizeSelection(auth.user.id, { categoryId: input.categoryId, ...(input.tags === undefined ? {} : { tags: input.tags as string[] }) });
    const record = await repos.videos.register({ ownerId: auth.user.id, originalObject: { kind: "legacy", key: objectKey }, playbackObject: { kind: "legacy", key: objectKey }, thumbnailObject: null,
      video: { id: randomUUID(), title: input.title.trim(), ...selection, durationSeconds: null, sizeBytes: 0, status: "processing", thumbnailUrl: null,
        createdAt: (deps.now?.() ?? new Date()).toISOString(), codec: null, width: null, height: null, playable: false, lastPositionSeconds: 0 } });
    return { data: record.video };
  });
  app.get<{ Params: { videoId: string } }>("/api/videos/:videoId", async request => {
    const auth = await deps.auth.requireUser(request, { mutation: false }); const record = await repos.videos.findOwned(auth.user.id, request.params.videoId);
    if (!record) throw new HttpError("NOT_FOUND"); return { data: record.video };
  });
  app.patch<{ Params: { videoId: string } }>("/api/videos/:videoId", async request => {
    const auth = await deps.auth.requireUser(request, { mutation: true }); const patch = body(request.body, deps.config.library ? ["title", "categoryId", "tags"] : ["title", "categoryId", "groupIds", "tagIds"]);
    return { data: await repos.catalog.update(auth.user.id, request.params.videoId, patch as UpdateVideoRequest) };
  });
  app.get("/api/settings/limits", async request => {
    await deps.auth.requireUser(request, { mutation: false }); const media = deps.config.media;
    if (!media || (!deps.config.library && deps.config.maxPlaybackSessions === null)) throw new HttpError("SERVICE_NOT_CONFIGURED");
    return { data: { maxUploadBytes: media.maxUploadBytes, partSizeBytes: media.partSizeBytes, maxUploadConcurrency: media.maxUploadConcurrency,
      maxPlaybackSessions: deps.config.maxPlaybackSessions ?? 0, maxAuthorizationsPerMinute: deps.config.library ? 0 : media.maxAuthorizationsPerMinute,
      uploadObjectPrefix: deps.config.library?.objectPrefix ?? media.uploadObjectPrefix ?? `${media.objectPrefix}originals/` } };
  });
  return repos;
}
