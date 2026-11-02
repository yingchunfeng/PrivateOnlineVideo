import type { AccountMutationResult, AccountOperationRequest, AccountSecuritySummary, AuthSession, BindEmailConfirmRequest, BindEmailRequest, ChangeEmailConfirmRequest, ChangeEmailRequest, ChangePasswordRequest, EmailChallenge, EmailChangeAuthorization, LoginCodeRequest, LoginOptions, LoginRequest, LoginSession, PasswordCodeRequest, VerifyOldEmailRequest } from "@online-video/shared";
import { GUEST_PERMISSIONS, isEmailProviderList } from "@online-video/shared";
import { ApiClient, ApiError } from "./client";

export function validateAuthSession(value: AuthSession): AuthSession {
  if (value?.user?.role !== undefined && !["admin", "guest"].includes(value.user.role)) throw new ApiError("INVALID_RESPONSE", "登录身份无法确认，请重新登录");
  if (value?.guest && (value.user?.role !== "guest" || !value.guest.id || typeof value.guest.name !== "string" || !Array.isArray(value.guest.permissions) || value.guest.permissions.some(permission => !GUEST_PERMISSIONS.includes(permission)) || ![value.guest.expiresAt, value.guest.serverTime].every(time => typeof time === "string" && Number.isFinite(Date.parse(time))))) throw new ApiError("INVALID_RESPONSE", "访客权限信息不完整，请重新登录");
  if (value?.user?.role === "guest" && !value.guest) throw new ApiError("INVALID_RESPONSE", "访客身份信息不完整，请重新登录");
  if (!value || typeof value.csrfToken !== "string" || !value.csrfToken || !value.user || typeof value.user.id !== "string" || !value.user.id || typeof value.user.displayName !== "string" || typeof value.user.totpEnabled !== "boolean" || !["password", "totp", "email"].includes(value.user.authMethod) || !Number.isSafeInteger(value.user.authVersion) || value.user.authVersion < 1 || !(value.user.emailMasked === null || typeof value.user.emailMasked === "string") || typeof value.user.emailVerified !== "boolean" || value.user.authMethod === "email" && (!value.user.emailVerified || !value.user.emailMasked)) throw new ApiError("INVALID_RESPONSE", "登录会话信息不完整，请重新尝试");
  return value;
}
export function validateEmailChallenge(value: EmailChallenge): EmailChallenge {
  if (!value || typeof value.challengeId !== "string" || !value.challengeId || !(value.operationId === null || typeof value.operationId === "string" && !!value.operationId) || typeof value.maskedEmail !== "string" || !value.maskedEmail || ![value.serverTime, value.expiresAt, value.resendAt].every(time => typeof time === "string" && Number.isFinite(Date.parse(time))) || Date.parse(value.expiresAt) <= Date.parse(value.serverTime)) throw new ApiError("INVALID_RESPONSE", "邮箱验证码信息不完整，请重新发送");
  return value;
}
function validateMutation(value: AccountMutationResult): AccountMutationResult {
  if (!value || value.success !== true || value.reloginRequired !== true || !["not_required", "pending", "sent", "failed"].includes(value.notificationStatus)) throw new ApiError("INVALID_RESPONSE", "账号修改结果无法确认，请重新登录后核对");
  return value;
}
export const authApi = (client: ApiClient) => ({
  options: async (signal?: AbortSignal) => {
    const value = await client.request<LoginOptions>("/api/auth/login/options", signal ? { signal } : {});
    if (!value || !["password", "totp", "email"].includes(value.authMethod) || !Number.isFinite(Date.parse(value.serverTime))) throw new ApiError("INVALID_RESPONSE", "登录方式无法确认，请重新加载");
    if (!isEmailProviderList(value.emailProviders)) throw new ApiError("INVALID_RESPONSE", "支持的邮箱类型无法确认，请重新加载");
    return value;
  },
  loginCode: async (body: LoginCodeRequest) => validateEmailChallenge(await client.request<EmailChallenge>("/api/auth/login/code", { method: "POST", body })),
  me: async (signal?: AbortSignal) => validateAuthSession(await client.request<AuthSession>("/api/auth/me", signal ? { signal } : {})),
  login: async (body: LoginRequest) => validateAuthSession(await client.request<AuthSession>("/api/auth/login", { method: "POST", body })),
  logout: () => client.request<{ success: true }>("/api/auth/logout", { method: "POST" }),
  sessions: () => client.request<LoginSession[]>("/api/auth/sessions"),
  revoke: (id: string) => client.request<{ success: true }>(`/api/auth/sessions/${encodeURIComponent(id)}/revoke`, { method: "POST" }),
  security: async () => {
    const value = await client.request<AccountSecuritySummary>("/api/auth/security");
    if (!value || !["password", "totp", "email"].includes(value.authMethod) || !Number.isSafeInteger(value.authVersion) || value.authVersion < 1 || !(value.email === null || typeof value.email === "string") || typeof value.emailVerified !== "boolean" || typeof value.totpAvailable !== "boolean" || !Number.isFinite(Date.parse(value.serverTime)) || value.authMethod === "email" && (!value.email || !value.emailVerified)) throw new ApiError("INVALID_RESPONSE", "账号安全信息不完整，请重新加载");
    if (!isEmailProviderList(value.emailProviders)) throw new ApiError("INVALID_RESPONSE", "支持的邮箱类型无法确认，请重新加载");
    return value;
  },
  bindCode: async (body: BindEmailRequest) => validateEmailChallenge(await client.request<EmailChallenge>("/api/auth/email/bind/code", { method: "POST", body })),
  bindConfirm: async (body: BindEmailConfirmRequest) => validateMutation(await client.request<AccountMutationResult>("/api/auth/email/bind/confirm", { method: "POST", body })),
  passwordCode: async (body: PasswordCodeRequest) => validateEmailChallenge(await client.request<EmailChallenge>("/api/auth/password/code", { method: "POST", body })),
  passwordConfirm: async (body: ChangePasswordRequest) => validateMutation(await client.request<AccountMutationResult>("/api/auth/password/confirm", { method: "POST", body })),
  passwordDirect: async (body: { currentPassword: string; newPassword: string; confirmPassword: string }) => validateMutation(await client.request<AccountMutationResult>("/api/auth/password/direct", { method: "POST", body })),
  emailVerificationCode: async (body: { currentPassword: string; enabled: boolean; email?: string }) => validateEmailChallenge(await client.request<EmailChallenge>("/api/auth/email-verification/code", { method: "POST", body })),
  emailVerificationConfirm: async (body: { currentPassword: string; enabled: boolean; email?: string; challengeId: string; code: string }) => validateMutation(await client.request<AccountMutationResult>("/api/auth/email-verification/confirm", { method: "POST", body })),
  emailOldCode: async (body: ChangeEmailRequest) => validateEmailChallenge(await client.request<EmailChallenge>("/api/auth/email/change/old/code", { method: "POST", body })),
  emailVerifyOld: (body: VerifyOldEmailRequest) => client.request<EmailChangeAuthorization>("/api/auth/email/change/old/verify", { method: "POST", body }),
  emailNewCode: async (body: AccountOperationRequest) => validateEmailChallenge(await client.request<EmailChallenge>("/api/auth/email/change/new/code", { method: "POST", body })),
  emailConfirm: async (body: ChangeEmailConfirmRequest) => validateMutation(await client.request<AccountMutationResult>("/api/auth/email/change/confirm", { method: "POST", body })),
  cancelOperation: (body: AccountOperationRequest) => client.request<{ success: true }>("/api/auth/operations/cancel", { method: "POST", body })
});
