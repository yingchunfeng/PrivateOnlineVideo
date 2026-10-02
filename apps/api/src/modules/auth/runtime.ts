import { eq } from "drizzle-orm";
import { openDatabase } from "../../db/database.js";
import { users } from "../../db/schema.js";
import { ConfigurationError } from "../../core/config.js";
import type { AppConfig } from "../../core/config.js";
import { readAuthSettings } from "./settings.js";
import { decryptSecret, readMasterKey } from "./crypto.js";
import { AuthService } from "./service.js";

export async function loadRuntimeAuth(config: AppConfig) {
  const settings = readAuthSettings(config.environment); const key = await readMasterKey(settings.keyFile);
  const database = openDatabase(settings.databasePath);
  try {
    const user = database.orm.select().from(users).where(eq(users.singleton, 1)).get();
    if (!user || !user.totpEnabled) throw new ConfigurationError("本人账户未完成初始化；请使用受保护的本地初始化命令");
    decryptSecret(user.totpCipher, key);
    return { service: new AuthService(database, key, settings), database };
  } catch (error) { database.close(); throw error; }
}
