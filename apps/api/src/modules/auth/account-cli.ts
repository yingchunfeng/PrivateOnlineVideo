import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ConfigurationError, readConfig } from "../../core/config.js";
import { guardLocalFile, openDatabase, WORKSPACE_ROOT } from "../../db/database.js";
import { readMasterKey } from "./crypto.js";
import { AuthService, initializeAccount } from "./service.js";
import { readAuthSettings } from "./settings.js";

const args = process.argv.slice(2);
const argument = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
try {
  const config = readConfig(); const settings = readAuthSettings(config.environment);
  if (args[0] === "init") {
    const output = guardLocalFile(argument("--output") ?? resolve(WORKSPACE_ROOT, ".local/account-setup.json"));
    if (existsSync(settings.databasePath) || existsSync(output)) throw new ConfigurationError("数据库或账号初始化资料已存在，拒绝重复初始化或覆盖；请核查现有资料");
    await mkdir(dirname(settings.databasePath), { recursive: true }); await mkdir(dirname(settings.keyFile), { recursive: true }); await mkdir(dirname(output), { recursive: true });
    let masterKey: Buffer;
    if (existsSync(settings.keyFile)) masterKey = await readMasterKey(settings.keyFile);
    else { masterKey = randomBytes(32); const key = await open(settings.keyFile, "wx", 0o600); try { await key.writeFile(masterKey); await key.sync(); } finally { await key.close(); } }
    const reserved = await open(settings.databasePath, "wx", 0o600); await reserved.close();
    const database = openDatabase(settings.databasePath, { initialize: true });
    try {
      await initializeAccount(database, masterKey, argument("--display-name") ?? "本人", async credentials => {
        const file = await open(output, "wx", 0o600);
        try { await file.writeFile(JSON.stringify({ ...credentials, databasePath: settings.databasePath,
          instructions: "在验证器中手动添加 totpSecret（时间型，SHA1，6位，30秒）或导入 otpauthUri。登录只需密码+动态码。恢复码和本文件仅本人离线保管。" }, null, 2), "utf8"); await file.sync(); }
        finally { await file.close(); }
      });
      console.log(`本人账户已创建。初始密码、TOTP 配置与恢复码保存在：${output}`);
    } finally { database.close(); }
  } else if (args[0] === "recover") {
    const inputPath = argument("--input"); if (!inputPath) throw new ConfigurationError("恢复需要 --input <.local 内的 JSON 文件>，包含当前密码 password 和单次恢复码 recoveryCode");
    const input = await readFile(guardLocalFile(inputPath)); if (input.length > 16_384) throw new ConfigurationError("恢复输入过大");
    const value = JSON.parse(input.toString("utf8")) as { password?: unknown; recoveryCode?: unknown };
    if (typeof value.password !== "string" || value.password.length > 512 || typeof value.recoveryCode !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(value.recoveryCode)) throw new ConfigurationError("恢复输入格式不正确");
    const database = openDatabase(settings.databasePath);
    try {
      const service = new AuthService(database, await readMasterKey(settings.keyFile), settings);
      const output = guardLocalFile(resolve(WORKSPACE_ROOT, `.local/account-recovery-${Date.now()}-${randomUUID()}.json`));
      await service.recover(value.password, value.recoveryCode, async result => {
        const file = await open(output, "wx", 0o600); try { await file.writeFile(JSON.stringify(result, null, 2), "utf8"); await file.sync(); } finally { await file.close(); }
      });
      console.log(`身份验证通过，TOTP 已更新、旧会话和旧恢复码已撤销。新绑定资料：${output}`);
    } finally { database.close(); }
  } else throw new ConfigurationError("只允许本地 init 或 recover；没有公开注册/匿名重置入口");
} catch (error) {
  console.error(error instanceof ConfigurationError ? error.message : "账号操作失败；已保留数据库和本地资料，未覆盖或删除，请人工核查");
  process.exitCode = 1;
}
