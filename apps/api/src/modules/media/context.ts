import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthPrincipal, MediaDependencies } from "../../core/contracts/index.js";
import type { MediaOptions } from "./options.js";
import { HttpError } from "../../core/errors.js";
import { ObjectScope } from "./storage/scope.js";
import { RequestLimiter } from "./limits/rate.js";
import { MAX_ORGANIZATION_LINKS } from "@online-video/shared";
import type { OrganizationSelection } from "@online-video/shared";
import { guestRequestSignal } from "../../core/guest-access.js";

export interface MediaContext { dependencies: MediaDependencies; options: MediaOptions; scope: ObjectScope; limiter: RequestLimiter }
export async function principal(context: MediaContext, request: FastifyRequest, mutation = false): Promise<AuthPrincipal> {
  return context.dependencies.auth.requireUser(request, { mutation });
}
export function recordBody(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HttpError("VALIDATION_ERROR");
  return value as Record<string, unknown>;
}
export function text(value: unknown, max = 256): string {
  if (typeof value !== "string" || value.trim().length < 1 || value.length > max || /[\x00-\x1f]/.test(value)) {
    throw new HttpError("VALIDATION_ERROR");
  }
  return value;
}
export function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new HttpError("VALIDATION_ERROR");
  return value;
}
export function organizationSelection(body: Record<string, unknown>): OrganizationSelection {
  const ids = (value: unknown): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > MAX_ORGANIZATION_LINKS) throw new HttpError("VALIDATION_ERROR");
    const result = value.map(id => text(id));
    if (new Set(result).size !== result.length) throw new HttpError("VALIDATION_ERROR");
    return result;
  };
  return { categoryId: text(body.categoryId), groupIds: ids(body.groupIds), tagIds: ids(body.tagIds) };
}
export async function assertOrganization(context: MediaContext, ownerId: string, selection: OrganizationSelection): Promise<void> {
  if (context.dependencies.organizations) return context.dependencies.organizations.assertOwned(ownerId, selection);
  if (context.dependencies.videos.assertOrganizationOwned) return context.dependencies.videos.assertOrganizationOwned(ownerId, selection);
  if (selection.groupIds?.length || selection.tagIds?.length) throw new HttpError("SERVICE_NOT_CONFIGURED");
  return context.dependencies.videos.assertCategoryOwned(ownerId, selection.categoryId);
}
export function requestSignal(request: FastifyRequest, reply: FastifyReply) {
  const controller = new AbortController(); const abort = () => controller.abort();
  const guestSignal = guestRequestSignal(request);
  guestSignal?.addEventListener("abort", abort, { once: true });
  if (guestSignal?.aborted) abort();
  // 完整收到请求体后 IncomingMessage 未必发 aborted；等待响应时仍要取消上游。
  const responseClosed = () => { if (!reply.raw.writableFinished) abort(); };
  request.raw.once("aborted", abort);
  reply.raw.once("close", responseClosed);
  if (request.raw.aborted || (reply.raw.destroyed && !reply.raw.writableFinished)) abort();
  return { controller, dispose: () => { guestSignal?.removeEventListener("abort", abort); request.raw.removeListener("aborted", abort); reply.raw.removeListener("close", responseClosed); } };
}
