import { eq } from "drizzle-orm";
import { openDatabase } from "../../db/database.js";
import { users } from "../../db/schema.js";
import { ConfigurationError } from "../../core/config.js";
import type { AppConfig } from "../../core/config.js";
import { readAuthSettings } from "./settings.js";
import { decryptSecret, readMasterKey } from "./crypto.js";
import { AuthService, accountReady } from "./service.js";
import { loadMailSender } from "./mail.js";
import { authenticationUser } from "./login-mode.js";

export async function loadRuntimeAuth(config: AppConfig) {
  const settings = readAuthSettings(config.environment); const key = await readMasterKey(settings.keyFile);
  const database = openDatabase(settings.databasePath);
  try {
    const user = database.orm.select().from(users).where(eq(users.singleton, 1)).get();
    if (!user || !accountReady(authenticationUser(database, user))) throw new ConfigurationError("本人账户认证状态无效；请核查数据库或使用受保护的本地恢复命令");
    if (user.totpEnabled) decryptSecret(user.totpCipher, key);
    return { service: new AuthService(database, key, settings, () => new Date(), loadMailSender(database, key)), database };
  } catch (error) { database.close(); throw error; }
}
