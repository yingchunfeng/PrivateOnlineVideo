import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { AuthSession, LoginRequest, LoginSession } from "@online-video/shared";
import type { AuthGuard, AuthPrincipal } from "../../core/contracts/index.js";
import { HttpError } from "../../core/errors.js";
import type { AppDatabase } from "../../db/database.js";
import * as s from "../../db/schema.js";
import type { AuthSettings } from "./settings.js";
import { csrfToken, decryptSecret, encryptSecret, equalToken, hashPassword, newRecoveryCodes, randomToken, tokenHash, totp, verifyPassword } from "./crypto.js";

export class AuthService implements AuthGuard {
  private hashing = 0;
  readonly cookieName: string;
  constructor(readonly database: AppDatabase, readonly key: Buffer, readonly settings: AuthSettings, readonly now: () => Date = () => new Date()) {
    if (key.length !== 32) throw new Error("invalid auth key");
    this.cookieName = settings.secureCookie ? "__Host-ov_session" : "ov_session";
  }
  private audit(action: string, ownerId?: string) { this.database.orm.insert(s.auditEvents).values({ id: randomUUID(), ownerId: ownerId ?? null, action, createdAt: this.now().toISOString() }).run(); }
  assertOrigin(request: FastifyRequest): void {
    if (typeof request.headers.origin !== "string" || !this.settings.allowedOrigins.includes(request.headers.origin) || request.headers["sec-fetch-site"] === "cross-site") throw new HttpError("CSRF_REJECTED");
  }
  private attempt(ip: string) {
    const keys = ["account", `ip:${tokenHash(ip)}`]; const at = this.now().getTime();
    this.database.client.transaction(() => {
      for (const key of keys) {
        const row = this.database.orm.select().from(s.loginAttempts).where(eq(s.loginAttempts.key, key)).get();
        const failures = row && at - row.windowStart < this.settings.failureWindowMs ? row.failures : 0;
        if (failures >= this.settings.maxFailures) throw new HttpError("RATE_LIMITED");
        this.database.orm.insert(s.loginAttempts).values({ key, windowStart: failures ? row!.windowStart : at, failures: failures + 1 })
          .onConflictDoUpdate({ target: s.loginAttempts.key, set: { windowStart: failures ? row!.windowStart : at, failures: failures + 1 } }).run();
      }
    }).immediate();
    return keys;
  }
  async login(request: FastifyRequest, input: LoginRequest): Promise<{ token: string; data: AuthSession; expiresAt: string }> {
    this.assertOrigin(request);
    if (this.hashing >= 2) throw new HttpError("RATE_LIMITED");
    const keys = this.attempt(request.ip); this.hashing++;
    try {
      const user = this.database.orm.select().from(s.users).get();
      if (!user) throw new HttpError("SERVICE_NOT_CONFIGURED");
      const valid = await verifyPassword(user.passwordHash, input.password);
      const factor = totp(decryptSecret(user.totpCipher, this.key), user.displayName);
      const validatedAt = this.now().getTime();
      const delta = /^\d{6}$/.test(input.totp) ? factor.validate({ token: input.totp, timestamp: validatedAt, window: 1 }) : null;
      if (!valid || !user.totpEnabled || delta === null) { this.audit("login_failed", user.id); throw new HttpError("INVALID_CREDENTIALS"); }
      const counter = Math.floor(validatedAt / 30_000) + delta;
      const token = randomToken(); const at = this.now().toISOString(); const expiresAt = new Date(this.now().getTime() + this.settings.sessionTtlMs).toISOString();
      return this.database.client.transaction(() => {
        // 同一验证码在并发登录/重启后仍只能使用一次。
        const changed = this.database.orm.update(s.users).set({ lastTotpCounter: counter }).where(and(eq(s.users.id, user.id),
          eq(s.users.passwordHash, user.passwordHash), eq(s.users.totpCipher, user.totpCipher), eq(s.users.totpEnabled, true),
          sql`${s.users.lastTotpCounter} < ${counter}`)).run();
        if (changed.changes !== 1) throw new HttpError("INVALID_CREDENTIALS");
        this.database.orm.insert(s.loginSessions).values({ id: randomUUID(), ownerId: user.id, tokenHash: tokenHash(token), createdAt: at, lastSeenAt: at, expiresAt }).run();
        for (const key of keys) this.database.orm.update(s.loginAttempts).set({ failures: 0 }).where(eq(s.loginAttempts.key, key)).run();
        this.audit("login_succeeded", user.id);
        return { token, expiresAt, data: { user: { id: user.id, displayName: user.displayName, totpEnabled: true }, csrfToken: csrfToken(token, this.key) } };
      }).immediate();
    } finally { this.hashing--; }
  }
  private session(request: FastifyRequest) {
    const token = request.cookies?.[this.cookieName];
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError("AUTH_REQUIRED");
    const row = this.database.orm.select().from(s.loginSessions).where(eq(s.loginSessions.tokenHash, tokenHash(token))).get();
    if (!row || row.revokedAt || row.expiresAt <= this.now().toISOString()) throw new HttpError("SESSION_EXPIRED");
    const user = this.database.orm.select().from(s.users).where(eq(s.users.id, row.ownerId)).get();
    if (!user || !user.totpEnabled) throw new HttpError("SESSION_EXPIRED");
    return { row, user, token };
  }
  async requireUser(request: FastifyRequest, options: { mutation: boolean }): Promise<AuthPrincipal> {
    const { row, user, token } = this.session(request);
    if (options.mutation) { this.assertOrigin(request); if (!equalToken(request.headers["x-csrf-token"], csrfToken(token, this.key))) throw new HttpError("CSRF_REJECTED"); }
    this.database.orm.update(s.loginSessions).set({ lastSeenAt: this.now().toISOString() }).where(eq(s.loginSessions.id, row.id)).run();
    return { user: { id: user.id, displayName: user.displayName, totpEnabled: true }, loginSessionId: row.id };
  }
  async me(request: FastifyRequest): Promise<AuthSession> { const principal = await this.requireUser(request, { mutation: false }); return { user: principal.user, csrfToken: csrfToken(this.session(request).token, this.key) }; }
  async sessions(request: FastifyRequest): Promise<LoginSession[]> {
    const principal = await this.requireUser(request, { mutation: false });
    return this.database.orm.select().from(s.loginSessions).where(and(eq(s.loginSessions.ownerId, principal.user.id), isNull(s.loginSessions.revokedAt))).orderBy(s.loginSessions.createdAt).all()
      .map(row => ({ id: row.id, createdAt: row.createdAt, lastSeenAt: row.lastSeenAt, expiresAt: row.expiresAt, isCurrent: row.id === principal.loginSessionId }));
  }
  async revoke(request: FastifyRequest, id?: string): Promise<void> {
    const principal = await this.requireUser(request, { mutation: true }); const target = id ?? principal.loginSessionId;
    this.database.client.transaction(() => {
      const row = this.database.orm.select().from(s.loginSessions).where(and(eq(s.loginSessions.id, target), eq(s.loginSessions.ownerId, principal.user.id))).get();
      if (!row) throw new HttpError("NOT_FOUND");
      const at = this.now().toISOString(); this.database.orm.update(s.loginSessions).set({ revokedAt: row.revokedAt ?? at }).where(eq(s.loginSessions.id, target)).run();
      this.database.orm.update(s.playbackSessions).set({ closedAt: at }).where(and(eq(s.playbackSessions.loginSessionId, target), isNull(s.playbackSessions.closedAt))).run();
      this.audit("session_revoked", principal.user.id);
    }).immediate();
  }
  async recover(password: string, code: string, persist?: (value: { displayName: string; totpSecret: string; otpauthUri: string; recoveryCodes: string[] }) => Promise<void>) {
    const keys = this.attempt("local-recovery");
    const user = this.database.orm.select().from(s.users).get();
    if (!user || !await verifyPassword(user.passwordHash, password)) throw new HttpError("AUTH_REQUIRED");
    const verifiedCode = this.database.orm.select().from(s.recoveryCodes).where(and(eq(s.recoveryCodes.ownerId, user.id), eq(s.recoveryCodes.codeHash, tokenHash(code)), isNull(s.recoveryCodes.usedAt))).get();
    if (!verifiedCode) throw new HttpError("AUTH_REQUIRED");
    const factor = totp(undefined, user.displayName); const recovery = newRecoveryCodes();
    const result = { displayName: user.displayName, totpSecret: factor.secret.base32, otpauthUri: factor.toString(), recoveryCodes: recovery };
    // 先持久保存新绑定资料，写盘失败不能使原验证器/恢复码失效。
    await persist?.(result);
    this.database.client.transaction(() => {
      const consumed = this.database.orm.update(s.recoveryCodes).set({ usedAt: this.now().toISOString() }).where(and(eq(s.recoveryCodes.ownerId, user.id), eq(s.recoveryCodes.codeHash, tokenHash(code)), isNull(s.recoveryCodes.usedAt))).run();
      if (consumed.changes !== 1) throw new HttpError("AUTH_REQUIRED");
      this.database.orm.update(s.users).set({ totpCipher: encryptSecret(factor.secret.base32, this.key), lastTotpCounter: -1 }).where(eq(s.users.id, user.id)).run();
      const at = this.now().toISOString();
      this.database.orm.update(s.loginSessions).set({ revokedAt: at }).where(eq(s.loginSessions.ownerId, user.id)).run();
      this.database.orm.update(s.playbackSessions).set({ closedAt: at }).where(eq(s.playbackSessions.ownerId, user.id)).run();
      // 旧恢复码保留历史并全部失效，不删除记录。
      this.database.orm.update(s.recoveryCodes).set({ usedAt: at }).where(and(eq(s.recoveryCodes.ownerId, user.id), isNull(s.recoveryCodes.usedAt))).run();
      for (const value of recovery) this.database.orm.insert(s.recoveryCodes).values({ id: randomUUID(), ownerId: user.id, codeHash: tokenHash(value) }).run();
      for (const key of keys) this.database.orm.update(s.loginAttempts).set({ failures: 0 }).where(eq(s.loginAttempts.key, key)).run();
      this.audit("account_recovered", user.id);
    }).immediate();
    return result;
  }
}

/** 仅本地 CLI 调用，数据库单人唯一约束避免重复初始化；不提供公开注册路由。 */
export async function initializeAccount(database: AppDatabase, masterKey: Buffer, displayName = "本人",
  persist?: (value: { displayName: string; password: string; totpSecret: string; otpauthUri: string; recoveryCodes: string[] }) => Promise<void>) {
  if (database.orm.select().from(s.users).get()) throw new Error("account already exists");
  if (!displayName.trim() || displayName.length > 100) throw new Error("invalid display name");
  const password = randomToken(); const passwordHash = await hashPassword(password); const factor = totp(undefined, displayName); const recovery = newRecoveryCodes();
  const result = { displayName, password, totpSecret: factor.secret.base32, otpauthUri: factor.toString(), recoveryCodes: recovery };
  await persist?.(result);
  const id = randomUUID(); const at = new Date().toISOString();
  database.client.transaction(() => {
    database.orm.insert(s.users).values({ id, displayName, passwordHash, totpCipher: encryptSecret(factor.secret.base32, masterKey), createdAt: at }).run();
    database.orm.insert(s.categories).values({ id: randomUUID(), ownerId: id, name: "未分类", sortOrder: 0, isDefault: true, createdAt: at }).run();
    for (const code of recovery) database.orm.insert(s.recoveryCodes).values({ id: randomUUID(), ownerId: id, codeHash: tokenHash(code) }).run();
    database.orm.insert(s.auditEvents).values({ id: randomUUID(), ownerId: id, action: "account_initialized", createdAt: at }).run();
  }).immediate();
  return result;
}
