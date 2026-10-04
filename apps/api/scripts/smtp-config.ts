import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { ConfigurationError } from "../src/core/config.js";
import { DEFAULT_AUTH_KEY_PATH, guardDatabasePath, guardLocalFile, openDatabase, WORKSPACE_ROOT } from "../src/db/database.js";
import { users } from "../src/db/schema.js";
import { decryptSecret, readMasterKey } from "../src/modules/auth/crypto.js";
import { saveSmtpConfiguration, validateSmtpConfiguration } from "../src/modules/auth/mail.js";

async function readInput(path: string): Promise<unknown> {
  let bytes: Buffer;
  if (path === "-") {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.from(chunk); size += buffer.length;
      if (size > 16_384) throw new ConfigurationError("SMTP 输入过大");
      chunks.push(buffer);
    }
    bytes = Buffer.concat(chunks);
  } else bytes = await readFile(guardLocalFile(path));
  if (bytes.length > 16_384) throw new ConfigurationError("SMTP 输入过大");
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new ConfigurationError("SMTP 输入必须是 UTF-8 无 BOM 的 JSON，详见 --help"); }
}

export async function main(args = process.argv.slice(2)) {
  if (!args.length || (args.length === 1 && args[0] === "--help")) {
    console.log(`SMTP 配置仅保存在数据库，授权码使用匹配的 auth.key 加密；更新前自动新建 SQLite 一致性备份。
在项目根目录执行：
npm run mail:configure -w @online-video/api -- --database E:/onlineVideo/.local/data/video-library.db --input E:/onlineVideo/.local/secrets/smtp-input.json --apply

JSON 字段：host、port、secure（布尔值）、user、password（授权码）、from，可选 timeoutMs（默认15000）、providerCode（qq或163，省略时按账号识别）。
QQ 使用 smtp.qq.com 与 @qq.com 账号，163 使用 smtp.163.com 与 @163.com 账号，From 必须与账号一致。
按类型保存到 smtp_provider_configs，一种类型只保留一条；保存163不会覆盖QQ。类型启停由 smtp_provider_types.enabled 控制。
--input - 表示从标准输入读取 JSON；不把授权码作为命令参数传入。
--key-file 可指定项目 .local 内匹配的原 auth.key；默认使用 AUTH_KEY_FILE 或 .local/secrets/auth.key。
仅 --apply 执行写入；命令不自动迁移数据库，不连接 SMTP，不输出配置或授权码。配置更新后重启 API 生效。
原 smtp.json/SMTP_CONFIG_FILE 不再作为运行配置；已有文件保留，需显式导入。`);
    return;
  }
  const options: Record<string, string> = {}; let apply = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === "--apply" && !apply) { apply = true; continue; }
    const value = args[index + 1];
    if (!["--database", "--input", "--key-file"].includes(flag) || !value || value.startsWith("--") || options[flag]) throw new ConfigurationError("SMTP 命令参数不合法，请执行 --help");
    options[flag] = value; index++;
  }
  if (!apply || !options["--database"] || !options["--input"]) throw new ConfigurationError("需要 --database <项目 .local 内的数据库> --input <JSON文件或-> --apply");
  const path = guardDatabasePath(options["--database"]);
  const value = validateSmtpConfiguration(await readInput(options["--input"]));
  const key = await readMasterKey(guardLocalFile(options["--key-file"] ?? process.env.AUTH_KEY_FILE ?? DEFAULT_AUTH_KEY_PATH));
  const database = openDatabase(path);
  try {
    const user = database.orm.select().from(users).where(eq(users.singleton, 1)).get();
    if (!user) throw new ConfigurationError("目标库没有本人账号，拒绝保存 SMTP 配置");
    decryptSecret(user.totpCipher, key);
    const directory = resolve(WORKSPACE_ROOT, ".local/backups"); await mkdir(directory, { recursive: true });
    const backup = resolve(directory, `before-smtp-config-${Date.now()}-${crypto.randomUUID()}.db`);
    await database.client.backup(backup);
    saveSmtpConfiguration(database, key, value);
    console.log(`SMTP 配置已加密保存到 smtp_provider_configs，类型：${value.providerCode}；重启 API 后生效。一致性备份：${backup}`);
  } finally { database.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof ConfigurationError ? error.message : "SMTP 配置保存失败，请检查受保护输入、数据库和密钥；原始凭证及异常不输出");
    process.exitCode = 1;
  });
}
