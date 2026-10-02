import type { FastifyInstance } from "fastify";
import { ERROR_DEFINITIONS } from "@online-video/shared";
import type { ErrorCode, ErrorResponse } from "@online-video/shared";

/** 对外消息只使用公共错误表；内部异常原文不得返回给客户端或写入基础日志。 */
export class HttpError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) { super(ERROR_DEFINITIONS[code].message); this.code = code; }
}
export function registerErrorHandlers(app: FastifyInstance): void {
  app.setNotFoundHandler(() => { throw new HttpError("NOT_FOUND"); });
  app.setErrorHandler((error, request, reply) => {
    let code: ErrorCode = "INTERNAL_ERROR";
    const frameworkError = typeof error === "object" && error !== null
      ? error as { validation?: unknown; statusCode?: unknown } : {};
    if (error instanceof HttpError) code = error.code;
    else if (frameworkError.validation || frameworkError.statusCode === 400) code = "VALIDATION_ERROR";
    else if (frameworkError.statusCode === 413) code = "PAYLOAD_TOO_LARGE";
    else if (frameworkError.statusCode === 415) code = "UNSUPPORTED_MEDIA_TYPE";
    const definition = ERROR_DEFINITIONS[code];
    request.log[definition.status >= 500 ? "error" : "warn"]({ code, requestId: request.id }, "request failed");
    // 流式响应开始后不能追加 JSON，交给媒体模块记录计量并取消上游。
    if (reply.raw.headersSent) { reply.raw.destroy(); return; }
    const payload: ErrorResponse = { error: { code, message: definition.message, requestId: request.id } };
    void reply.status(definition.status).send(payload);
  });
}
