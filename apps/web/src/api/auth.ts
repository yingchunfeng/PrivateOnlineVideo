import type { AuthSession, LoginRequest, LoginSession } from "@online-video/shared";
import { ApiClient, ApiError } from "./client";

export function validateAuthSession(value: AuthSession): AuthSession {
  if (!value || typeof value.csrfToken !== "string" || !value.csrfToken || !value.user || typeof value.user.id !== "string" || !value.user.id || typeof value.user.displayName !== "string" || typeof value.user.totpEnabled !== "boolean") throw new ApiError("INVALID_RESPONSE", "登录会话信息不完整，请重新尝试");
  return value;
}
export const authApi = (client: ApiClient) => ({
  me: async (signal?: AbortSignal) => validateAuthSession(await client.request<AuthSession>("/api/auth/me", signal ? { signal } : {})),
  login: async (body: LoginRequest) => validateAuthSession(await client.request<AuthSession>("/api/auth/login", { method: "POST", body })),
  logout: () => client.request<{ success: true }>("/api/auth/logout", { method: "POST" }),
  sessions: () => client.request<LoginSession[]>("/api/auth/sessions"),
  revoke: (id: string) => client.request<{ success: true }>(`/api/auth/sessions/${encodeURIComponent(id)}/revoke`, { method: "POST" })
});
