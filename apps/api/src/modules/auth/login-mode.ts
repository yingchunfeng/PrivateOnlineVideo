import type { AuthMethod } from "@online-video/shared";
import type { AppDatabase } from "../../db/database.js";
import type { users } from "../../db/schema.js";

type StoredUser = typeof users.$inferSelect;
export type AuthenticationUser = Omit<StoredUser, "authMethod"> & { authMethod: AuthMethod };

export function hasOnboardingSchema(database: AppDatabase): boolean {
  return !!database.client.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='installation_state'").get();
}

/** 没有扩展行的旧账号继续遵守原认证方式，不把关闭 TOTP 当作密码登录。 */
export function authenticationUser(database: AppDatabase, user: StoredUser): AuthenticationUser {
  if (!hasOnboardingSchema(database)) return user;
  const mode = database.client.prepare("SELECT method FROM account_login_modes WHERE owner_id=?").get(user.id) as { method: AuthMethod } | undefined;
  return mode ? { ...user, authMethod: mode.method } : user;
}

export function saveLoginMode(database: AppDatabase, ownerId: string, method: AuthMethod, at: string): void {
  if (!hasOnboardingSchema(database)) return;
  database.client.prepare("INSERT INTO account_login_modes(owner_id,method,updated_at) VALUES(?,?,?) ON CONFLICT(owner_id) DO UPDATE SET method=excluded.method,updated_at=excluded.updated_at")
    .run(ownerId, method, at);
}
