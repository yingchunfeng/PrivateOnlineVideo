/** 安装状态可公开查询，但安装码、密钥和配置内容只能通过受保护流程访问。 */
export interface SetupStatus {
  stage: "password" | "configuration" | "ready";
  authenticated: boolean;
  setupAvailable: boolean;
  csrfToken?: string;
}
export interface SetupLoginRequest { password: string; installationCode?: string }
export interface SetupPasswordRequest { newPassword: string; confirmPassword: string }
export interface DirectPasswordChangeRequest { currentPassword: string; newPassword: string; confirmPassword: string }
export interface EmailVerificationCodeRequest { currentPassword: string; enabled: boolean; email?: string }
export interface EmailVerificationConfirmRequest extends EmailVerificationCodeRequest { challengeId: string; code: string }

export interface SaveOssSettingsRequest {
  version: number;
  accessKeyId?: string;
  accessKeySecret?: string;
  bucket: string;
  region: string;
  network: "public" | "internal";
  allowPublicNetwork: boolean;
  mediaBaseUrl: string;
  objectPrefix: string;
  roleArn?: string;
}
export interface OssSettingsSummary {
  accessKeyIdMasked: string;
  secretConfigured: boolean;
  bucket: string;
  region: string;
  endpoint: string;
  network: "public" | "internal";
  allowPublicNetwork: boolean;
  mediaBaseUrl: string;
  objectPrefix: string;
  roleArn?: string;
  credentialMode: "direct" | "role";
}
export interface SaveSmtpSettingsRequest {
  version: number;
  providerCode: "qq" | "163";
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password?: string;
  from: string;
  timeoutMs?: number;
}
export interface SmtpSettingsSummary {
  providerCode: "qq" | "163";
  host: string;
  port: number;
  secure: boolean;
  user: string;
  from: string;
  timeoutMs: number;
  passwordConfigured: boolean;
  testedAt: string | null;
}
export interface InstallationSettingsSummary {
  version: number;
  oss: OssSettingsSummary | null;
  mail: SmtpSettingsSummary[];
  ossTest: { checkedAt: string; scope: "list-prefix" } | null;
}
export interface TestOssSettingsRequest { version: number }
export interface TestOssSettingsResult { checkedAt: string; scope: "list-prefix"; writePermissionVerified: false }
export interface TestMailSettingsRequest { version: number; providerCode: "qq" | "163"; to: string }
export interface TestMailSettingsResult { accepted: true; testedAt: string; toMasked: string; delivery: "smtp-accepted" }
