export type EmailProviderCode = "qq" | "163";
export interface EmailProviderType { code: EmailProviderCode; name: string; domain: string }
export const SUPPORTED_EMAIL_PROVIDERS: readonly EmailProviderType[] = [
  { code: "qq", name: "QQ 邮箱", domain: "qq.com" },
  { code: "163", name: "163 邮箱", domain: "163.com" }
];

export function normalizeEmailAddress(input: string): string | null {
  const value = input.trim().toLowerCase(); const name = value.split("@")[0]!;
  if (value.length > 254 || name.length > 64 || name.startsWith(".") || name.endsWith(".") || value.includes("..") ||
    !/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(value)) return null;
  return value;
}

export function findEmailProvider(input: string, providers: readonly EmailProviderType[] = SUPPORTED_EMAIL_PROVIDERS): EmailProviderType | undefined {
  const email = normalizeEmailAddress(input);
  return email ? providers.find(provider => provider.domain === email.split("@")[1]) : undefined;
}

export function isEmailProviderList(input: unknown): input is EmailProviderType[] {
  return Array.isArray(input) && input.length <= SUPPORTED_EMAIL_PROVIDERS.length && new Set(input.map(value => value?.code)).size === input.length &&
    input.every(value => value && typeof value.name === "string" && value.name.length > 0 && value.name.length <= 80 &&
      SUPPORTED_EMAIL_PROVIDERS.some(provider => value.code === provider.code && value.domain === provider.domain));
}
