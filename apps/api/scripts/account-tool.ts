import Database from "better-sqlite3";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_AUTH_KEY_PATH, DEFAULT_DATABASE_PATH, guardDatabasePath, guardLocalFile, WORKSPACE_ROOT } from "../src/db/database.js";
import { decryptSecret, encryptSecret, hashPassword, readMasterKey, totp, verifyPassword } from "../src/modules/auth/crypto.js";
import { ConfigurationError } from "../src/core/config.js";

class InputError extends Error {}
const text = (value: unknown, field: string, max = 16384) => {
  if (typeof value !== "string" || !value || value.length > max) throw new InputError(`${field} 必须是非空字符串，最长 ${max} 字符`);
  return value;
};
async function jsonFile(path: string): Promise<Record<string, unknown>> {
  const bytes = await readFile(guardLocalFile(path));
  if (bytes.length > 65536) throw new InputError("输入文件超过 64 KiB");
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("输入文件必须是 JSON 对象");
  return value as Record<string, unknown>;
}

/** 复用网站算法；密码哈希不可逆，随机盐和 IV 会使重复输入的结果不同。 */
export async function cryptoAction(action: string, input: Record<string, unknown>, key?: Buffer) {
  if (action === "hash-password") return { hash: await hashPassword(text(input.password, "password", 512)) };
  if (action === "verify-password") {
    const digest = text(input.hash, "hash");
    if (!digest.startsWith("$argon2id$")) throw new InputError("hash 必须是项目使用的 Argon2id 哈希");
    return { matches: await verifyPassword(digest, text(input.password, "password", 512)) };
  }
  if (!key || key.length !== 32) throw new InputError("加密/解密需要原有的 32 字节 auth.key");
  if (action === "encrypt-secret") return { ciphertext: encryptSecret(text(input.secret, "secret"), key) };
  if (action === "decrypt-secret") {
    const ciphertext = text(input.ciphertext, "ciphertext");
    if (ciphertext.split(".").length !== 4) throw new InputError("ciphertext 必须是 v1.IV.TAG.DATA 格式");
    return { secret: decryptSecret(ciphertext, key) };
  }
  throw new InputError("不支持该命令");
}

/** 只读原数据库，不启动 API、不消费验证码、不初始化或更新账号。 */
export async function loginMaterial(showPassword: boolean, setupPath = resolve(WORKSPACE_ROOT, ".local/account-setup.json"), env = process.env, now = Date.now()): Promise<{
  displayName: string; authMethod: "totp" | "email"; emailMasked: string | null; password?: string; passwordSource?: string; totp?: string; validSeconds?: number; alreadyUsed?: boolean; note: string
}> {
  const databasePath = guardDatabasePath(env.DATABASE_PATH ?? DEFAULT_DATABASE_PATH);
  const keyFile = guardLocalFile(env.AUTH_KEY_FILE ?? DEFAULT_AUTH_KEY_PATH);
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const columns = new Set((database.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map(row => row.name));
    const authentication = columns.has("auth_method") ? "auth_method,email,email_verified_at" : "'totp' AS auth_method,NULL AS email,NULL AS email_verified_at";
    const user = database.prepare(`SELECT display_name,password_hash,totp_cipher,last_totp_counter,${authentication} FROM users WHERE singleton=1`).get() as
      { display_name: string; password_hash: string; totp_cipher: string; last_totp_counter: number; auth_method: "totp" | "email"; email: string | null; email_verified_at: string | null } | undefined;
    if (!user) throw new InputError("没有找到原账号；此工具不会初始化账号");
    let password: string | undefined;
    if (showPassword) {
      const setup = await jsonFile(setupPath); password = text(setup.password, "password", 512);
      if (!await verifyPassword(user.password_hash, password)) throw new InputError("初始化文件中的密码已与当前账号不同，请使用当前密码；此工具不会重置密码");
    }
    const base = { displayName: user.display_name, authMethod: user.auth_method,
      emailMasked: user.email ? `${user.email.slice(0, 1)}***@${user.email.split("@")[1]}` : null,
      ...(password === undefined ? {} : { password, passwordSource: "初始化历史资料；已经数据库当前哈希核对" }) };
    if (user.auth_method === "email") return { ...base, note: "当前账号使用邮箱验证码登录。保留的旧 TOTP 仅供受保护恢复，不能用于普通登录；请在登录页输入当前密码并发送邮件验证码。" };
    const secret = decryptSecret(user.totp_cipher, await readMasterKey(keyFile));
    const counter = Math.floor(now / 30000); const alreadyUsed = counter <= user.last_totp_counter;
    return { ...base, totp: totp(secret, user.display_name).generate({ timestamp: now }),
      validSeconds: Math.ceil((30000 - now % 30000) / 1000), alreadyUsed,
      note: alreadyUsed ? "当前验证码已用于登录，请在下一周期重新执行 code。" : "使用密码与此六位验证码登录；生成验证码本身不会消费它。" };
  } finally { database.close(); }
}

export async function main(args = process.argv.slice(2)) {
  const action = args[0];
  if (!action || action === "--help" || action === "help") {
    console.log(`在 E:/onlineVideo 执行，无需启动 API 或 Web：
node --import tsx apps/api/scripts/account-tool.ts show
node --import tsx apps/api/scripts/account-tool.ts code
node --import tsx apps/api/scripts/account-tool.ts hash-password --input .local/password-input.json
node --import tsx apps/api/scripts/account-tool.ts verify-password --input .local/password-check.json
node --import tsx apps/api/scripts/account-tool.ts encrypt-secret --input .local/secret-input.json
node --import tsx apps/api/scripts/account-tool.ts decrypt-secret --input .local/cipher-input.json

show：只读初始化历史密码并核对数据库，过时密码会拒绝显示。code：仅在当前 TOTP 模式生成登录验证码，邮箱模式显示说明。
hash-password 输入：{"password":"你的密码"}
verify-password 输入：{"password":"你的密码","hash":"Argon2id哈希"}
encrypt-secret 输入：{"secret":"需要加密的文本"}
decrypt-secret 输入：{"ciphertext":"v1.IV.TAG.DATA"}
加密/解密默认读取 .local/secrets/auth.key，可用 --key-file 指定 .local 内的原密钥文件。
密码哈希不能解密；相同密码的哈希不同，相同文本的密文也不同，通过校验/解密确认一致性。
所有命令不写数据库、不改账号、不保存输出；show 的历史密码仅在仍匹配数据库哈希时于本机终端显示；历史 JSON 不作为当前账号状态来源。`);
    return;
  }
  const options: Record<string, string> = {};
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index]; const value = args[index + 1];
    if (!flag || !["--input", "--key-file", "--setup"].includes(flag) || !value || value.startsWith("--") || options[flag]) throw new InputError("命令参数不合法，请执行 --help");
    options[flag] = value;
  }
  let result: unknown;
  if (action === "show" || action === "code") {
    if (options["--input"] || options["--key-file"] || (action === "code" && options["--setup"])) throw new InputError("show/code 不接受这些选项");
    result = await loginMaterial(action === "show", options["--setup"]);
  } else {
    if (!["hash-password", "verify-password", "encrypt-secret", "decrypt-secret"].includes(action) || !options["--input"] || options["--setup"]) throw new InputError("请提供有效命令及 --input JSON文件，详见 --help");
    const input = await jsonFile(options["--input"]);
    const key = action.endsWith("-secret") ? await readMasterKey(guardLocalFile(options["--key-file"] ?? process.env.AUTH_KEY_FILE ?? DEFAULT_AUTH_KEY_PATH)) : undefined;
    result = await cryptoAction(action, input, key);
  }
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof InputError || error instanceof ConfigurationError ? error.message : "本地工具执行失败，请检查输入文件与原有账号资料；未修改数据库或密钥");
    process.exitCode = 1;
  });
}
