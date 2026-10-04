import type { FastifyInstance } from "fastify";
import type { BackendDependencies } from "../catalog/routes.js";
import { createRepositories } from "../../db/repositories.js";
import { HttpError } from "../../core/errors.js";
export function registerProgressModule(app: FastifyInstance, deps: BackendDependencies) {
  const progress = createRepositories(deps.database, deps.now ?? (() => new Date()), deps.config.library).progress;
  app.get<{ Params: { videoId: string } }>("/api/videos/:videoId/progress", async request => {
    const auth = await deps.auth.requireUser(request, { mutation: false }); return { data: await progress.read(auth.user.id, request.params.videoId) };
  });
  app.put<{ Params: { videoId: string } }>("/api/videos/:videoId/progress", async request => {
    const auth = await deps.auth.requireUser(request, { mutation: true }); const input = request.body as { positionSeconds?: unknown };
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1 || typeof input.positionSeconds !== "number") throw new HttpError("VALIDATION_ERROR");
    return { data: await progress.save(auth.user.id, request.params.videoId, input.positionSeconds) };
  });
}
