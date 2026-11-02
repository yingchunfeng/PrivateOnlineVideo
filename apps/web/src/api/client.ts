import { CSRF_HEADER, ERROR_DEFINITIONS, PART_CHECKSUM_HEADER } from "@online-video/shared";
import type { ApiPath, ApiResponse, ErrorCode, ErrorResponse } from "@online-video/shared";

export class ApiError extends Error {
  constructor(public readonly code: ErrorCode | "NETWORK_ERROR" | "INVALID_RESPONSE", message: string, public readonly requestId = "", public readonly status?: number) {
    super(message);
  }
}

export type Transport = (input: string, init?: RequestInit) => Promise<Response>;
export const isSiteApiPath = (value: string): value is ApiPath => {
  if (!/^\/api\/(?!\/)[^\\\s#]*$/.test(value)) return false;
  try {
    const url = new URL(value, "https://site.invalid");
    const path = decodeURIComponent(url.pathname);
    return url.origin === "https://site.invalid" && url.pathname === value.split("?")[0] && path.startsWith("/api/") && !path.includes("\\") && !path.split("/").some(segment => segment === "." || segment === "..");
  } catch { return false; }
};

export class ApiClient {
  private csrf = "";
  private unauthorized: (() => void) | undefined;
  constructor(private readonly transport: Transport) {}
  setSession(csrfToken: string) { this.csrf = csrfToken; }
  clearSession() { this.csrf = ""; }
  onUnauthorized(callback: () => void) { this.unauthorized = callback; }
  async request<T>(path: ApiPath, options: { method?: string; body?: unknown; signal?: AbortSignal; keepalive?: boolean } = {}): Promise<T> {
    const method = options.method ?? "GET";
    return this.send<T>(path, { method, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal ? { signal: options.signal } : {}), ...(options.keepalive ? { keepalive: true } : {}),
      headers: options.body === undefined ? {} : { "content-type": "application/json" } });
  }
  async part<T>(path: ApiPath, blob: Blob, checksum: string, signal?: AbortSignal): Promise<T> {
    return this.send<T>(path, { method: "PUT", body: blob, ...(signal ? { signal } : {}),
      headers: { "content-type": "application/octet-stream", [PART_CHECKSUM_HEADER]: checksum } });
  }
  async image<T>(path: ApiPath, blob: Blob, signal?: AbortSignal): Promise<T> {
    return this.send<T>(path, { method: "PUT", body: blob, ...(signal ? { signal } : {}), headers: { "content-type": "image/jpeg" } });
  }
  private async send<T>(path: ApiPath, init: RequestInit): Promise<T> {
    if (!isSiteApiPath(path)) throw new ApiError("VALIDATION_ERROR", "资源地址必须为站内 API");
    const headers = new Headers(init.headers);
    const publicLoginRequest = (init.method ?? "GET") === "POST" && (path === "/api/auth/login" || path === "/api/auth/guest/login" || path === "/api/auth/login/code" || path === "/api/setup/login");
    if (!["GET", "HEAD"].includes(init.method ?? "GET") && !publicLoginRequest) {
      if (!this.csrf) throw new ApiError("CSRF_REJECTED", "会话校验信息已失效，请重新登录");
      headers.set(CSRF_HEADER, this.csrf);
    }
    let response: Response;
    try { response = await this.transport(path, { ...init, headers, credentials: "same-origin", cache: "no-store", redirect: "error" }); }
    catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new ApiError("NETWORK_ERROR", "连接中断，请检查网络后重试");
    }
    if (response.status === 401) { this.clearSession(); this.unauthorized?.(); }
    let payload: unknown;
    try { payload = await response.json(); }
    catch { throw new ApiError(response.status === 401 ? "AUTH_REQUIRED" : "INVALID_RESPONSE", response.status === 401 ? "登录会话已失效，请重新登录" : "服务响应无法读取，请稍后重试", "", response.status); }
    if (!response.ok) {
      const raw = payload as Partial<ErrorResponse>;
      const code = raw?.error?.code;
      if (typeof code !== "string" || !Object.hasOwn(ERROR_DEFINITIONS, code)) throw new ApiError(response.status === 401 ? "AUTH_REQUIRED" : "INVALID_RESPONSE", response.status === 401 ? "登录会话已失效，请重新登录" : "服务返回了未知错误", "", response.status);
      if (response.status !== 401 && (code === "AUTH_REQUIRED" || code === "SESSION_EXPIRED")) { this.clearSession(); this.unauthorized?.(); }
      throw new ApiError(code, ERROR_DEFINITIONS[code].message, raw.error?.requestId ?? "", response.status);
    }
    if (!payload || typeof payload !== "object" || !("data" in payload)) throw new ApiError("INVALID_RESPONSE", "服务响应格式不正确");
    return (payload as ApiResponse<T>).data;
  }
}
