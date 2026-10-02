import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthPrincipal, MediaDependencies } from "../../core/contracts/index.js";
import type { MediaOptions } from "./options.js";
import { HttpError } from "../../core/errors.js";
import { ObjectScope } from "./storage/scope.js";
import { RequestLimiter } from "./limits/rate.js";

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
export function requestSignal(request: FastifyRequest, reply: FastifyReply) {
  const controller = new AbortController(); const abort = () => controller.abort();
  // 完整收到请求体后 IncomingMessage 未必发 aborted；等待响应时仍要取消上游。
  const responseClosed = () => { if (!reply.raw.writableFinished) abort(); };
  request.raw.once("aborted", abort);
  reply.raw.once("close", responseClosed);
  if (request.raw.aborted || (reply.raw.destroyed && !reply.raw.writableFinished)) abort();
  return { controller, dispose: () => { request.raw.removeListener("aborted", abort); reply.raw.removeListener("close", responseClosed); } };
}
