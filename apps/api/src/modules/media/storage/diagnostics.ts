import { HttpError } from "../../../core/errors.js";

/** 仅分类 SDK 的 code/name/status，不回传 message、URL、响应头或凭据。 */
export function storageDiagnostic(error: unknown, stage: "oss" | "sts", operation?: "list"): HttpError {
  if (error instanceof HttpError) {
    if (operation === "list" && error.code === "FORBIDDEN") return new HttpError("OSS_RESPONSE_INVALID");
    return error;
  }
  const records: { code?: unknown; name?: unknown; status?: unknown; statusCode?: unknown; cause?: unknown }[] = [];
  let current = error;
  for (let i = 0; i < 3 && current && typeof current === "object"; i++) {
    const record = current as typeof records[number]; records.push(record); current = record.cause;
  }
  const codes = records.flatMap(record => [record.code, record.name]).filter((value): value is string => typeof value === "string");
  const matches = (...known: string[]) => codes.some(code => known.includes(code));
  if (matches("RequestTimeTooSkewed", "RequestTimeTooSkewedError", "InvalidTimeStamp.Expired", "RequestExpired")) return new HttpError("OSS_CLOCK_SKEW");
  if (matches("InvalidAccessKeyId", "InvalidAccessKeyIdError", "InvalidAccessKeyId.NotFound", "SignatureDoesNotMatch", "SignatureDoesNotMatchError", "InvalidSecurityToken", "SecurityTokenExpired", "InvalidToken", "InvalidAccessKeySecret")) return new HttpError("OSS_INVALID_CREDENTIALS");
  if (matches("ETIMEDOUT", "ESOCKETTIMEDOUT", "ConnectTimeoutError", "RequestTimeout", "RequestTimeoutError", "ResponseTimeoutError", "TimeoutError", "ConnectionTimeoutError")) return new HttpError("OSS_REQUEST_TIMEOUT");
  if (matches("ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN", "SocketError", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID")) return new HttpError("OSS_NETWORK_ERROR");
  if (stage === "oss" && matches("NoSuchBucket", "NoSuchBucketError")) return new HttpError("OSS_BUCKET_NOT_FOUND");
  if (stage === "oss" && (matches("PermanentRedirect", "PermanentRedirectError", "TemporaryRedirect", "AuthorizationHeaderMalformed", "IncorrectEndpoint") || records.some(row => row.status === 301 || row.status === 307))) return new HttpError("OSS_ENDPOINT_MISMATCH");
  if (stage === "sts" && matches("InvalidParameter.DurationSeconds", "InvalidParameter.RoleArn", "InvalidParameter.Policy", "InvalidPolicyDocument", "InvalidPolicyDocumentError", "EntityNotExist.Role")) return new HttpError("OSS_STS_CONFIGURATION_ERROR");
  const denied = matches("AccessDenied", "AccessDeniedError", "AccessForbidden", "AccessForbiddenError", "NoPermission", "Forbidden", "Forbidden.RAM", "NoPermission.RAM") || records.some(row => row.status === 403 || row.statusCode === 403);
  if (denied) return new HttpError(stage === "sts" ? "OSS_STS_PERMISSION_DENIED" : operation === "list" ? "OSS_LIST_PERMISSION_DENIED" : "STORAGE_PERMISSION_DENIED");
  // 分片合并前 HEAD 对象尚不存在，上传流程依赖 NOT_FOUND 继续完成合并。
  if (stage === "oss" && matches("NoSuchKey", "NoSuchKeyError")) return new HttpError("NOT_FOUND");
  return new HttpError("STORAGE_UNAVAILABLE");
}
