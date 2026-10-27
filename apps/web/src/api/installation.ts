import type { InstallationSettingsSummary, SaveOssSettingsRequest, SaveSmtpSettingsRequest, SetupLoginRequest, SetupPasswordRequest, SetupStatus, TestMailSettingsRequest, TestMailSettingsResult, TestOssSettingsResult } from "@online-video/shared";
import { ApiClient, ApiError } from "./client";

const invalid = () => new ApiError("INVALID_RESPONSE", "安装配置信息无法确认，请刷新后重试");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const time = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
export function validateSetupStatus(value: SetupStatus): SetupStatus {
  if (!object(value) || !["password", "configuration", "ready"].includes(value.stage) || typeof value.authenticated !== "boolean" || typeof value.setupAvailable !== "boolean" || !value.setupAvailable && value.stage !== "ready" || value.authenticated && value.stage !== "ready" && (typeof value.csrfToken !== "string" || !value.csrfToken) || value.csrfToken !== undefined && typeof value.csrfToken !== "string") throw invalid();
  return value;
}
export function validateInstallationSummary(value: InstallationSettingsSummary): InstallationSettingsSummary {
  if (!object(value) || !Number.isSafeInteger(value.version) || value.version < 0 || !Array.isArray(value.mail) || value.mail.length > 2 || !(value.oss === null || object(value.oss)) || !(value.ossTest === null || object(value.ossTest) && value.ossTest.scope === "list-prefix" && time(value.ossTest.checkedAt))) throw invalid();
  if (value.oss) {
    const oss = value.oss;
    if (["accessKeyId", "accessKeySecret", "password", "secret"].some(key => Object.hasOwn(oss, key)) || typeof oss.accessKeyIdMasked !== "string" || typeof oss.secretConfigured !== "boolean" || ![oss.bucket, oss.region, oss.endpoint, oss.mediaBaseUrl, oss.objectPrefix].every(field => typeof field === "string" && !!field) || !["public", "internal"].includes(oss.network) || !["direct", "role"].includes(oss.credentialMode) || typeof oss.allowPublicNetwork !== "boolean" || oss.roleArn !== undefined && typeof oss.roleArn !== "string") throw invalid();
  }
  const providers = new Set<string>();
  for (const mail of value.mail) {
    if (!object(mail) || !["qq", "163"].includes(mail.providerCode) || providers.has(mail.providerCode) || ![mail.host, mail.user, mail.from].every(field => typeof field === "string" && !!field) || !Number.isInteger(mail.port) || ![465, 587].includes(mail.port) || typeof mail.secure !== "boolean" || typeof mail.passwordConfigured !== "boolean" || !Number.isInteger(mail.timeoutMs) || mail.timeoutMs <= 0 || !(mail.testedAt === null || time(mail.testedAt)) || ["password", "passwordCipher", "password_cipher", "authorizationCode"].some(key => Object.hasOwn(mail, key))) throw invalid();
    providers.add(mail.providerCode);
  }
  return value;
}
export const installationApi = (client: ApiClient) => ({
  status: async (signal?: AbortSignal): Promise<SetupStatus> => {
    try { return validateSetupStatus(await client.request<SetupStatus>("/api/setup/status", signal ? { signal } : {})); }
    catch (error) {
      // 只兼容确实未提供安装 API 的旧版本；网络失败或其他错误不能解锁业务。
      if (error instanceof ApiError && error.status === 404) return { stage: "ready", authenticated: false, setupAvailable: false };
      throw error;
    }
  },
  login: async (body: SetupLoginRequest) => validateSetupStatus(await client.request<SetupStatus>("/api/setup/login", { method: "POST", body })),
  password: async (body: SetupPasswordRequest) => validateSetupStatus(await client.request<SetupStatus>("/api/setup/password", { method: "POST", body })),
  complete: async () => {
    const result = await client.request<{ success: true }>("/api/setup/complete", { method: "POST", body: {} });
    if (!result || result.success !== true) throw invalid();
    // 完成接口撤销安装 Cookie；必须重新读取状态，不能仅凭按钮响应解锁业务。
    return validateSetupStatus(await client.request<SetupStatus>("/api/setup/status"));
  },
  settings: async () => validateInstallationSummary(await client.request<InstallationSettingsSummary>("/api/installation/settings")),
  saveOss: async (body: SaveOssSettingsRequest) => validateInstallationSummary(await client.request<InstallationSettingsSummary>("/api/installation/oss", { method: "PUT", body })),
  saveMail: async (body: SaveSmtpSettingsRequest) => validateInstallationSummary(await client.request<InstallationSettingsSummary>("/api/installation/mail", { method: "PUT", body })),
  testOss: async (version: number) => {
    const value = await client.request<TestOssSettingsResult>("/api/installation/oss/test", { method: "POST", body: { version } });
    if (!value || value.scope !== "list-prefix" || value.writePermissionVerified !== false || !time(value.checkedAt)) throw invalid();
    return value;
  },
  testMail: async (body: TestMailSettingsRequest) => {
    const value = await client.request<TestMailSettingsResult>("/api/installation/mail/test", { method: "POST", body });
    if (!value || value.accepted !== true || value.delivery !== "smtp-accepted" || !time(value.testedAt) || typeof value.toMasked !== "string" || !value.toMasked) throw invalid();
    return value;
  }
});
