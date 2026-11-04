const forbiddenMarkers = ["demo-password", "mock-owner", "ov.dev-mock", "devMock=1", "totpSecret", "account-setup.json", "auth.key", "better-sqlite3", "ali-oss", "node:crypto", "node:fs", "SMTP_CONFIG_FILE", "smtp.json", "nodemailer", "mock-password", "MockMailSender"];
const credentialPatterns = [
  /\bLTAI[0-9A-Za-z]{12,40}\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{40,255})\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  /["']?\baccessKey(?:Id|Secret)["']?\s*[:=]\s*["'][^"'\r\n]+["']/i
];

/** 配置表单字段名可以公开；凭据值、Mock 和服务端实现不能进入发布产物。 */
export function assertSafeReleaseFile(name: string, text: string): void {
  if (name.endsWith(".map") || /mock|fixtures/i.test(name)) throw new Error(`独立发布目录含开发产物：${name}`);
  for (const marker of forbiddenMarkers) {
    if (text.includes(marker)) throw new Error(`独立发布产物含禁止标记：${marker}`);
  }
  if (credentialPatterns.some(pattern => pattern.test(text))) throw new Error(`独立发布产物含疑似凭据：${name}`);
}
