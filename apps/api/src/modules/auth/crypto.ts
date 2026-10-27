import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { hash, verify } from "@node-rs/argon2";
import { Secret, TOTP } from "otpauth";
import { ConfigurationError } from "../../core/config.js";

// SDK 声明 Algorithm 为 ambient const enum；2 是已核验的 Argon2id 值，避免运行时导入。
export const passwordPolicy = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 } as const;
export const hashPassword = (password: string) => hash(password, passwordPolicy);
export const verifyPassword = (digest: string, password: string) => verify(digest, password);
export const tokenHash = (value: string) => createHash("sha256").update(value).digest("hex");
export const randomToken = () => randomBytes(32).toString("base64url");
export const newRecoveryCodes = () => Array.from({ length: 10 }, () => randomBytes(16).toString("base64url"));
export function totp(secret = new Secret({ size: 20 }).base32, label = "本人") {
  return new TOTP({ issuer: "PrivateVideoLibrary", label, algorithm: "SHA1", digits: 6, period: 30, secret });
}
export async function readMasterKey(path: string): Promise<Buffer> {
  try { const key = await readFile(path); if (key.length !== 32) throw new Error("invalid key"); return key; }
  catch { throw new ConfigurationError("账号安全密钥不存在或长度不正确；请检查初始化资料，不会重新生成或降低验证要求"); }
}
export function encryptSecret(secret: string, key: Buffer, purpose: "totp" | "smtp" | "installation" = "totp"): string {
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(Buffer.from(`video-library:${purpose}:v1`));
  const data = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}
export function decryptSecret(value: string, key: Buffer, purpose: "totp" | "smtp" | "installation" = "totp"): string {
  try {
    const [version, nonce, tag, encoded] = value.split("."); if (version !== "v1" || !nonce || !tag || !encoded) throw new Error("invalid ciphertext");
    const cipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64url")); cipher.setAAD(Buffer.from(`video-library:${purpose}:v1`));
    cipher.setAuthTag(Buffer.from(tag, "base64url")); return Buffer.concat([cipher.update(Buffer.from(encoded, "base64url")), cipher.final()]).toString("utf8");
  } catch { throw new ConfigurationError("无法解密账号验证码配置，请检查匹配的安全密钥"); }
}
export const csrfToken = (cookie: string, key: Buffer) => createHmac("sha256", key).update(`csrf:${cookie}`).digest("base64url");
export function equalToken(left: unknown, right: string): boolean {
  if (typeof left !== "string" || left.length !== right.length) return false;
  const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b);
}
