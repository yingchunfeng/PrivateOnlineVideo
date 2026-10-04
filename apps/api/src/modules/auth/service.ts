import { createHmac, randomInt, randomUUID } from "node:crypto";
import { and, eq, isNull, sql, desc, gte } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { normalizeEmailAddress } from "@online-video/shared";
import type { AuthSession, LoginRequest, LoginSession, CurrentUser, LoginOptions, LoginCodeRequest, EmailChallenge, EmailChallengePurpose,
  AccountSecuritySummary, BindEmailRequest, BindEmailConfirmRequest, PasswordCodeRequest, ChangePasswordRequest, ChangeEmailRequest,
  VerifyOldEmailRequest, AccountOperationRequest, EmailChangeAuthorization, ChangeEmailConfirmRequest, AccountMutationResult, ErrorCode, NotificationStatus } from "@online-video/shared";
import type { AuthGuard, AuthPrincipal } from "../../core/contracts/index.js";
import { HttpError } from "../../core/errors.js";
import type { AppDatabase } from "../../db/database.js";
import * as s from "../../db/schema.js";
import type { AuthSettings } from "./settings.js";
import { enabledEmailProviders, requireSupportedEmailProvider, UnconfiguredMailSender } from "./mail.js";
import type { MailSender, MailMessage } from "./mail.js";
import { csrfToken, decryptSecret, encryptSecret, equalToken, hashPassword, newRecoveryCodes, randomToken, tokenHash, totp, verifyPassword } from "./crypto.js";

type User = typeof s.users.$inferSelect;
type Operation = typeof s.accountOperations.$inferSelect;
type Challenge = typeof s.emailChallenges.$inferSelect;
export const maskEmail = (email: string) => { const [name, domain] = email.split("@"); return `${name!.slice(0, 1)}***@${domain}`; };
export function accountReady(user: User): boolean { return user.authMethod === "totp" ? user.totpEnabled : !!(user.email && user.emailVerifiedAt); }
export function currentUser(user: User): CurrentUser { return { id: user.id, displayName: user.displayName, totpEnabled: user.totpEnabled,
  authMethod: user.authMethod, authVersion: user.authVersion, emailMasked: user.email ? maskEmail(user.email) : null, emailVerified: !!user.emailVerifiedAt }; }

export class AuthService implements AuthGuard {
  private hashing = 0;
  readonly cookieName: string;
  constructor(readonly database: AppDatabase, readonly key: Buffer, readonly settings: AuthSettings, readonly now: () => Date = () => new Date(), readonly mailSender: MailSender = new UnconfiguredMailSender()) {
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
      const user = this.mainAccount();
      const valid = await verifyPassword(user.passwordHash, input.password);
      if (!valid) { this.audit("login_failed", user.id); throw new HttpError("INVALID_CREDENTIALS"); }
      if (user.authMethod !== (input.authMethod ?? "totp")) throw new HttpError("AUTH_METHOD_MISMATCH");
      if (input.authMethod === "email") this.requireEmail(user);
      const validatedAt = this.now().getTime();
      const delta = input.authMethod === "email" ? null : this.totpDelta(user, input.totp);
      if (!accountReady(user) || (user.authMethod === "totp" && delta === null)) { this.audit("login_failed", user.id); throw new HttpError("INVALID_CREDENTIALS"); }
      const counter = Math.floor(validatedAt / 30_000) + (delta ?? 0);
      const token = randomToken(); const at = this.now().toISOString(); const expiresAt = new Date(this.now().getTime() + this.settings.sessionTtlMs).toISOString();
      const outcome = this.database.client.transaction(() => {
        this.snapshot(user);
        if (input.authMethod === "email") {
          const error = this.consume(input.challengeId, input.code, user, "login", user.email!, null, null);
          if (error) return { error };
        } else {
          // 同一 TOTP 在并发登录/重启后仍只能使用一次。
          const changed = this.database.orm.update(s.users).set({ lastTotpCounter: counter }).where(and(eq(s.users.id, user.id),
            eq(s.users.authMethod, "totp"), eq(s.users.totpEnabled, true), sql`${s.users.lastTotpCounter} < ${counter}`)).run();
          if (changed.changes !== 1) return { error: "INVALID_CREDENTIALS" as ErrorCode };
        }
        this.database.orm.insert(s.loginSessions).values({ id: randomUUID(), ownerId: user.id, authVersion: user.authVersion, tokenHash: tokenHash(token), createdAt: at, lastSeenAt: at, expiresAt }).run();
        for (const key of keys) this.database.orm.update(s.loginAttempts).set({ failures: 0 }).where(eq(s.loginAttempts.key, key)).run();
        this.audit("login_succeeded", user.id);
        return { result: { token, expiresAt, data: { user: currentUser(user), csrfToken: csrfToken(token, this.key) } } };
      }).immediate();
      if (outcome.error) throw new HttpError(outcome.error);
      return outcome.result!;
    } finally { this.hashing--; }
  }
  private session(request: FastifyRequest) {
    const token = request.cookies?.[this.cookieName];
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError("AUTH_REQUIRED");
    const row = this.database.orm.select().from(s.loginSessions).where(eq(s.loginSessions.tokenHash, tokenHash(token))).get();
    if (!row || row.revokedAt || row.expiresAt <= this.now().toISOString()) throw new HttpError("SESSION_EXPIRED");
    const user = this.database.orm.select().from(s.users).where(eq(s.users.id, row.ownerId)).get();
    if (!user || !accountReady(user) || row.authVersion !== user.authVersion) throw new HttpError("SESSION_EXPIRED");
    return { row, user, token };
  }
  async requireUser(request: FastifyRequest, options: { mutation: boolean }): Promise<AuthPrincipal> {
    const { row, user, token } = this.session(request);
    if (options.mutation) { this.assertOrigin(request); if (!equalToken(request.headers["x-csrf-token"], csrfToken(token, this.key))) throw new HttpError("CSRF_REJECTED"); }
    this.database.orm.update(s.loginSessions).set({ lastSeenAt: this.now().toISOString() }).where(eq(s.loginSessions.id, row.id)).run();
    return { user: currentUser(user), loginSessionId: row.id };
  }
  async me(request: FastifyRequest): Promise<AuthSession> { const principal = await this.requireUser(request, { mutation: false }); return { user: principal.user, csrfToken: csrfToken(this.session(request).token, this.key) }; }
  private mainAccount(): User {
    const user = this.database.orm.select().from(s.users).where(eq(s.users.singleton, 1)).get();
    if (!user) throw new HttpError("SERVICE_NOT_CONFIGURED");
    return user;
  }
  private snapshot(expected: User, requireReady = true): User {
    const user = this.mainAccount();
    if (user.id !== expected.id || user.authVersion !== expected.authVersion || user.passwordHash !== expected.passwordHash ||
      user.totpCipher !== expected.totpCipher || user.authMethod !== expected.authMethod || user.email !== expected.email || user.emailVerifiedAt !== expected.emailVerifiedAt)
      throw new HttpError("ACCOUNT_VERSION_CONFLICT");
    if (requireReady && !accountReady(user)) throw new HttpError("SERVICE_NOT_CONFIGURED");
    return user;
  }
  private liveSession(id: string, user: User) {
    const session = this.database.orm.select().from(s.loginSessions).where(eq(s.loginSessions.id, id)).get();
    if (!session || session.ownerId !== user.id || session.revokedAt || session.expiresAt <= this.now().toISOString() || session.authVersion !== user.authVersion)
      throw new HttpError("SESSION_EXPIRED");
  }
  private totpDelta(user: User, code: string): number | null {
    return user.totpEnabled && /^\d{6}$/.test(code) ? totp(decryptSecret(user.totpCipher, this.key), user.displayName)
      .validate({ token: code, timestamp: this.now().getTime(), window: 1 }) : null;
  }
  private clearAttempts(keys: string[]) { for (const key of keys) this.database.orm.update(s.loginAttempts).set({ failures: 0 }).where(eq(s.loginAttempts.key, key)).run(); }
  private async password(user: User, password: string, request: FastifyRequest, secondary = true, clearSuccess = true): Promise<string[]> {
    if (this.hashing >= 2) throw new HttpError("RATE_LIMITED");
    const keys = this.attempt(request.ip); this.hashing++;
    try {
      if (!await verifyPassword(user.passwordHash, password)) throw new HttpError(secondary ? "SECONDARY_AUTH_FAILED" : "INVALID_CREDENTIALS");
      if (clearSuccess) this.clearAttempts(keys); return keys;
    } finally { this.hashing--; }
  }
  private emailAddress(input: string): string {
    const value = normalizeEmailAddress(input); if (!value) throw new HttpError("VALIDATION_ERROR");
    requireSupportedEmailProvider(this.database, value);
    return value;
  }
  private requireEmail(user: User): string { if (user.authMethod !== "email" || !user.email || !user.emailVerifiedAt) throw new HttpError("EMAIL_REQUIRED"); return this.emailAddress(user.email); }
  loginOptions(): LoginOptions { return { authMethod: this.mainAccount().authMethod, serverTime: this.now().toISOString(), emailProviders: enabledEmailProviders(this.database) }; }
  async security(request: FastifyRequest): Promise<AccountSecuritySummary> {
    await this.requireUser(request, { mutation: false }); const user = this.session(request).user;
    return { authMethod: user.authMethod, authVersion: user.authVersion, email: user.email, emailVerified: !!user.emailVerifiedAt,
      emailVerifiedAt: user.emailVerifiedAt, totpAvailable: user.totpEnabled, serverTime: this.now().toISOString(), emailProviders: enabledEmailProviders(this.database) };
  }
  private operation(id: string, user: User, sessionId: string, type: Operation["operationType"], state: Operation["state"]): Operation {
    const op = this.database.orm.select().from(s.accountOperations).where(eq(s.accountOperations.id, id)).get();
    if (!op || op.ownerId !== user.id || op.loginSessionId !== sessionId || op.authVersion !== user.authVersion ||
      op.operationType !== type || op.state !== state || op.invalidatedAt || op.expiresAt <= this.now().toISOString()) throw new HttpError("ACCOUNT_OPERATION_INVALID");
    return op;
  }
  private digest(challenge: Pick<Challenge, "id" | "purpose" | "targetEmail" | "authVersion" | "operationId" | "loginSessionId">, code: string): string {
    return createHmac("sha256", this.key).update(JSON.stringify(["video-library:email-code:v1", challenge.id, challenge.purpose,
      challenge.targetEmail, challenge.authVersion, challenge.operationId, challenge.loginSessionId, code])).digest("hex");
  }
  private async deliver(message: MailMessage): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([this.mailSender.send(message), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new HttpError("MAIL_SEND_FAILED")), this.settings.mailTimeoutMs);
    })]); } finally { if (timer) clearTimeout(timer); }
  }
  private async challenge(request: FastifyRequest, user: User, purpose: EmailChallengePurpose, targetEmail: string, sessionId: string | null,
    operationInput: { type: Operation["operationType"]; targetEmail: string } | { operation: Operation } | null): Promise<EmailChallenge> {
    requireSupportedEmailProvider(this.database, targetEmail);
    const code = randomInt(0, 1_000_000).toString().padStart(6, "0"); const id = randomUUID();
    const reserved = this.database.client.transaction(() => {
      this.snapshot(user); if (sessionId) this.liveSession(sessionId, user);
      const at = this.now(); const atIso = at.toISOString();
      const latest = this.database.orm.select().from(s.emailChallenges).where(and(eq(s.emailChallenges.ownerId, user.id), eq(s.emailChallenges.purpose, purpose)))
        .orderBy(desc(s.emailChallenges.sendSequence)).get();
      if (latest && latest.resendAt > atIso) throw new HttpError("EMAIL_SEND_COOLDOWN");
      const ipHash = tokenHash(request.ip); const since = at.getTime() - 3_600_000;
      const accountCount = this.database.orm.select({ count: sql<number>`count(*)` }).from(s.emailSendLimits).where(and(eq(s.emailSendLimits.ownerId, user.id), gte(s.emailSendLimits.reservedAt, since))).get()!.count;
      const ipCount = this.database.orm.select({ count: sql<number>`count(*)` }).from(s.emailSendLimits).where(and(eq(s.emailSendLimits.ipHash, ipHash), gte(s.emailSendLimits.reservedAt, since))).get()!.count;
      if (accountCount >= this.settings.emailHourlyLimit || ipCount >= this.settings.emailHourlyLimit) throw new HttpError("RATE_LIMITED");
      let operationId: string | null = null;
      if (operationInput && "operation" in operationInput) {
        const op = operationInput.operation; this.operation(op.id, user, sessionId!, op.operationType, op.state); operationId = op.id;
      } else if (operationInput) {
        operationId = randomUUID(); this.database.orm.insert(s.accountOperations).values({ id: operationId, ownerId: user.id,
          loginSessionId: sessionId!, authVersion: user.authVersion, operationType: operationInput.type, targetEmail: operationInput.targetEmail,
          createdAt: atIso, expiresAt: new Date(at.getTime() + this.settings.operationTtlMs).toISOString() }).run();
      }
      const sequence = (this.database.orm.select({ value: sql<number>`coalesce(max(${s.emailChallenges.sendSequence}),0)` }).from(s.emailChallenges).get()!.value) + 1;
      const value: typeof s.emailChallenges.$inferInsert = { id, ownerId: user.id, purpose, targetEmail, authVersion: user.authVersion, operationId, loginSessionId: sessionId,
        sendSequence: sequence, codeDigest: this.digest({ id, purpose, targetEmail, authVersion: user.authVersion, operationId, loginSessionId: sessionId }, code),
        createdAt: atIso, expiresAt: new Date(at.getTime() + this.settings.emailCodeTtlMs).toISOString(), resendAt: new Date(at.getTime() + this.settings.emailResendMs).toISOString() };
      this.database.orm.insert(s.emailChallenges).values(value).run();
      this.database.orm.insert(s.emailSendLimits).values({ challengeId: id, ownerId: user.id, ipHash, reservedAt: at.getTime() }).run();
      return this.database.orm.select().from(s.emailChallenges).where(eq(s.emailChallenges.id, id)).get()!;
    }).immediate();
    try { await this.deliver({ kind: "verification", to: targetEmail, purpose, challengeId: id, code, expiresAt: reserved.expiresAt }); }
    catch (error) {
      this.database.orm.update(s.emailChallenges).set({ sendState: "failed" }).where(eq(s.emailChallenges.id, id)).run();
      throw new HttpError(error instanceof HttpError && error.code === "MAIL_NOT_CONFIGURED" ? "MAIL_NOT_CONFIGURED" : "MAIL_SEND_FAILED");
    }
    const success = this.database.client.transaction(() => {
      const at = this.now().toISOString(); const current = this.database.orm.select().from(s.emailChallenges).where(eq(s.emailChallenges.id, id)).get()!;
      let valid = !current.invalidatedAt && !current.usedAt && current.sendState === "pending" && current.expiresAt > at;
      try {
        this.snapshot(user); if (sessionId) this.liveSession(sessionId, user);
        if (reserved.operationId) {
          const expectedState = purpose === "change_email_new" ? "old_verified" : "pending";
          this.operation(reserved.operationId, user, sessionId!, purpose === "bind_email" ? "bind_email" : purpose === "change_password" ? "change_password" : "change_email", expectedState);
        }
      } catch { valid = false; }
      const newer = this.database.orm.select().from(s.emailChallenges).where(and(eq(s.emailChallenges.ownerId, user.id), eq(s.emailChallenges.purpose, purpose),
        sql`${s.emailChallenges.sendSequence} > ${reserved.sendSequence}`)).get();
      if (newer) valid = false;
      if (!valid) { this.database.orm.update(s.emailChallenges).set({ invalidatedAt: current.invalidatedAt ?? at }).where(eq(s.emailChallenges.id, id)).run(); return false; }
      this.database.orm.update(s.emailChallenges).set({ sendState: "sent" }).where(eq(s.emailChallenges.id, id)).run();
      this.database.orm.update(s.emailChallenges).set({ invalidatedAt: at }).where(and(eq(s.emailChallenges.ownerId, user.id), eq(s.emailChallenges.purpose, purpose),
        sql`${s.emailChallenges.id} <> ${id}`, isNull(s.emailChallenges.invalidatedAt), isNull(s.emailChallenges.usedAt), eq(s.emailChallenges.sendState, "sent"))).run();
      return true;
    }).immediate();
    if (!success) throw new HttpError("ACCOUNT_VERSION_CONFLICT");
    return { challengeId: id, operationId: reserved.operationId, maskedEmail: maskEmail(targetEmail), serverTime: this.now().toISOString(), expiresAt: reserved.expiresAt, resendAt: reserved.resendAt };
  }
  /** 调用者在事务结束后抛出错误，确保错误次数不会随着异常回滚。 */
  private consume(id: string, code: string, user: User, purpose: EmailChallengePurpose, targetEmail: string, sessionId: string | null, operationId: string | null): ErrorCode | null {
    const challenge = this.database.orm.select().from(s.emailChallenges).where(eq(s.emailChallenges.id, id)).get();
    if (!challenge || challenge.ownerId !== user.id || challenge.purpose !== purpose || challenge.targetEmail !== targetEmail ||
      challenge.authVersion !== user.authVersion || challenge.loginSessionId !== sessionId || challenge.operationId !== operationId) return "EMAIL_CHALLENGE_EXPIRED";
    if (challenge.errorCount >= this.settings.emailMaxErrors) return "EMAIL_CODE_ATTEMPTS_EXCEEDED";
    const at = this.now().toISOString();
    if (challenge.sendState !== "sent" || challenge.invalidatedAt || challenge.usedAt || challenge.expiresAt <= at) return "EMAIL_CHALLENGE_EXPIRED";
    if (!/^\d{6}$/.test(code) || !equalToken(this.digest(challenge, code), challenge.codeDigest)) {
      const errorCount = challenge.errorCount + 1;
      this.database.orm.update(s.emailChallenges).set({ errorCount, ...(errorCount >= this.settings.emailMaxErrors ? { invalidatedAt: at } : {}) }).where(eq(s.emailChallenges.id, id)).run();
      return errorCount >= this.settings.emailMaxErrors ? "EMAIL_CODE_ATTEMPTS_EXCEEDED" : "EMAIL_CODE_INVALID";
    }
    const changed = this.database.orm.update(s.emailChallenges).set({ usedAt: at }).where(and(eq(s.emailChallenges.id, id), isNull(s.emailChallenges.usedAt), isNull(s.emailChallenges.invalidatedAt))).run();
    return changed.changes === 1 ? null : "EMAIL_CHALLENGE_EXPIRED";
  }
  async requestLoginCode(request: FastifyRequest, input: LoginCodeRequest): Promise<EmailChallenge> {
    this.assertOrigin(request); const user = this.mainAccount(); await this.password(user, input.password, request, false);
    if (user.authMethod !== "email") throw new HttpError("AUTH_METHOD_MISMATCH");
    return this.challenge(request, user, "login", this.requireEmail(user), null, null);
  }
  async bindEmailRequest(request: FastifyRequest, input: BindEmailRequest): Promise<EmailChallenge> {
    const principal = await this.requireUser(request, { mutation: true }); const user = this.mainAccount();
    if (user.authMethod !== "totp") throw new HttpError("AUTH_METHOD_MISMATCH");
    const keys = await this.password(user, input.currentPassword, request, true, false);
    if (this.totpDelta(user, input.totp) === null) throw new HttpError("SECONDARY_AUTH_FAILED"); this.clearAttempts(keys);
    const email = this.emailAddress(input.email);
    return this.challenge(request, user, "bind_email", email, principal.loginSessionId, { type: "bind_email", targetEmail: email });
  }
  private invalidateAccount(user: User, operationId?: string) {
    const at = this.now().toISOString();
    this.database.orm.update(s.loginSessions).set({ revokedAt: at }).where(and(eq(s.loginSessions.ownerId, user.id), isNull(s.loginSessions.revokedAt))).run();
    this.database.orm.update(s.playbackSessions).set({ closedAt: at }).where(and(eq(s.playbackSessions.ownerId, user.id), isNull(s.playbackSessions.closedAt))).run();
    this.database.orm.update(s.emailChallenges).set({ invalidatedAt: at }).where(and(eq(s.emailChallenges.ownerId, user.id), isNull(s.emailChallenges.invalidatedAt))).run();
    this.database.orm.update(s.accountOperations).set({ state: "invalidated", invalidatedAt: at }).where(and(eq(s.accountOperations.ownerId, user.id),
      sql`${s.accountOperations.state} IN ('pending','old_verified')`)).run();
    if (operationId) this.database.orm.update(s.accountOperations).set({ state: "completed", invalidatedAt: null }).where(eq(s.accountOperations.id, operationId)).run();
  }
  async bindEmailConfirm(request: FastifyRequest, input: BindEmailConfirmRequest): Promise<AccountMutationResult> {
    const principal = await this.requireUser(request, { mutation: true }); const user = this.mainAccount();
    if (user.authMethod !== "totp") throw new HttpError("AUTH_METHOD_MISMATCH");
    const keys = await this.password(user, input.currentPassword, request, true, false);
    const error = this.database.client.transaction(() => {
      this.snapshot(user); this.liveSession(principal.loginSessionId, user);
      if (this.totpDelta(user, input.totp) === null) return "SECONDARY_AUTH_FAILED" as ErrorCode;
      this.clearAttempts(keys);
      const op = this.operation(input.operationId, user, principal.loginSessionId, "bind_email", "pending");
      requireSupportedEmailProvider(this.database, op.targetEmail);
      const error = this.consume(input.challengeId, input.code, user, "bind_email", op.targetEmail, principal.loginSessionId, op.id); if (error) return error;
      this.database.orm.update(s.users).set({ email: op.targetEmail, emailVerifiedAt: this.now().toISOString(), authMethod: "email", authVersion: user.authVersion + 1 }).where(eq(s.users.id, user.id)).run();
      this.invalidateAccount(user, op.id); this.audit("email_bound", user.id); return null;
    }).immediate();
    if (error) throw new HttpError(error);
    return { success: true, reloginRequired: true, notificationStatus: "not_required" };
  }
  async passwordRequest(request: FastifyRequest, input: PasswordCodeRequest): Promise<EmailChallenge> {
    const principal = await this.requireUser(request, { mutation: true }); const user = this.mainAccount(); const email = this.requireEmail(user);
    await this.password(user, input.currentPassword, request);
    return this.challenge(request, user, "change_password", email, principal.loginSessionId, { type: "change_password", targetEmail: email });
  }
  private notification(user: User, to: string, purpose: "password_changed" | "email_changed"): string {
    const id = randomUUID(); this.database.orm.insert(s.securityNotifications).values({ id, ownerId: user.id, targetEmail: to, purpose, createdAt: this.now().toISOString() }).run(); return id;
  }
  private async notify(id: string, to: string, purpose: "password_changed" | "email_changed"): Promise<NotificationStatus> {
    try {
      await this.deliver({ kind: "notification", to, purpose, changedAt: this.now().toISOString() });
      this.database.orm.update(s.securityNotifications).set({ state: "sent", completedAt: this.now().toISOString() }).where(eq(s.securityNotifications.id, id)).run();
      return "sent";
    } catch {
      // 已提交的账号修改不受投递或通知状态写入异常影响。
      try { this.database.orm.update(s.securityNotifications).set({ state: "failed", completedAt: this.now().toISOString() }).where(eq(s.securityNotifications.id, id)).run(); } catch { /* 保留 pending 记录以便本地核查。 */ }
      return "failed";
    }
  }
  async passwordConfirm(request: FastifyRequest, input: ChangePasswordRequest): Promise<AccountMutationResult> {
    const principal = await this.requireUser(request, { mutation: true }); const user = this.mainAccount(); const email = this.requireEmail(user);
    await this.password(user, input.currentPassword, request);
    if (input.newPassword.length < 12 || input.newPassword.length > 128 || input.newPassword !== input.confirmPassword) throw new HttpError("PASSWORD_POLICY_FAILED");
    if (input.newPassword === input.currentPassword) throw new HttpError("PASSWORD_UNCHANGED");
    const passwordHash = await hashPassword(input.newPassword);
    const outcome = this.database.client.transaction(() => {
      this.snapshot(user); this.liveSession(principal.loginSessionId, user);
      const op = this.operation(input.operationId, user, principal.loginSessionId, "change_password", "pending");
      const error = this.consume(input.challengeId, input.code, user, "change_password", email, principal.loginSessionId, op.id); if (error) return { error };
      this.database.orm.update(s.users).set({ passwordHash, authVersion: user.authVersion + 1 }).where(eq(s.users.id, user.id)).run();
      this.invalidateAccount(user, op.id); this.audit("password_changed", user.id);
      return { notificationId: this.notification(user, email, "password_changed") };
    }).immediate();
    if (outcome.error) throw new HttpError(outcome.error);
    return { success: true, reloginRequired: true, notificationStatus: await this.notify(outcome.notificationId!, email, "password_changed") };
  }
  async emailChangeRequest(request: FastifyRequest, input: ChangeEmailRequest): Promise<EmailChallenge> {
    const principal = await this.requireUser(request, { mutation: true }); const user = this.mainAccount(); const email = this.requireEmail(user);
    await this.password(user, input.currentPassword, request); const targetEmail = this.emailAddress(input.newEmail);
    if (targetEmail === email) throw new HttpError("EMAIL_UNCHANGED");
    return this.challenge(request, user, "change_email_old", email, principal.loginSessionId, { type: "change_email", targetEmail });
  }
  async emailChangeVerifyOld(request: FastifyRequest, input: VerifyOldEmailRequest): Promise<EmailChangeAuthorization> {
    const principal = await this.requireUser(request, { mutation: true }); const user = this.mainAccount(); const email = this.requireEmail(user);
    await this.password(user, input.currentPassword, request);
    const outcome = this.database.client.transaction(() => {
      this.snapshot(user); this.liveSession(principal.loginSessionId, user); const op = this.operation(input.operationId, user, principal.loginSessionId, "change_email", "pending");
      const error = this.consume(input.challengeId, input.code, user, "change_email_old", email, principal.loginSessionId, op.id); if (error) return { error };
      this.database.orm.update(s.accountOperations).set({ state: "old_verified", oldVerifiedAt: this.now().toISOString() }).where(eq(s.accountOperations.id, op.id)).run();
      return { op };
    }).immediate();
    if (outcome.error) throw new HttpError(outcome.error);
    return { operationId: outcome.op!.id, targetEmailMasked: maskEmail(outcome.op!.targetEmail), expiresAt: outcome.op!.expiresAt, serverTime: this.now().toISOString() };
  }
  async emailChangeRequestNew(request: FastifyRequest, input: AccountOperationRequest): Promise<EmailChallenge> {
    const principal = await this.requireUser(request, { mutation: true }); const user = this.mainAccount(); this.requireEmail(user);
    const op = this.operation(input.operationId, user, principal.loginSessionId, "change_email", "old_verified");
    requireSupportedEmailProvider(this.database, op.targetEmail);
    return this.challenge(request, user, "change_email_new", op.targetEmail, principal.loginSessionId, { operation: op });
  }
  async emailChangeConfirm(request: FastifyRequest, input: ChangeEmailConfirmRequest): Promise<AccountMutationResult> {
    const principal = await this.requireUser(request, { mutation: true }); const user = this.mainAccount(); const email = this.requireEmail(user);
    await this.password(user, input.currentPassword, request);
    const outcome = this.database.client.transaction(() => {
      this.snapshot(user); this.liveSession(principal.loginSessionId, user); const op = this.operation(input.operationId, user, principal.loginSessionId, "change_email", "old_verified");
      requireSupportedEmailProvider(this.database, op.targetEmail);
      if (op.targetEmail === email) return { error: "EMAIL_UNCHANGED" as ErrorCode };
      const error = this.consume(input.challengeId, input.code, user, "change_email_new", op.targetEmail, principal.loginSessionId, op.id); if (error) return { error };
      this.database.orm.update(s.users).set({ email: op.targetEmail, emailVerifiedAt: this.now().toISOString(), authVersion: user.authVersion + 1 }).where(eq(s.users.id, user.id)).run();
      this.invalidateAccount(user, op.id); this.audit("email_changed", user.id);
      return { notificationId: this.notification(user, email, "email_changed") };
    }).immediate();
    if (outcome.error) throw new HttpError(outcome.error);
    return { success: true, reloginRequired: true, notificationStatus: await this.notify(outcome.notificationId!, email, "email_changed") };
  }
  async cancelOperation(request: FastifyRequest, input: AccountOperationRequest): Promise<{ success: true }> {
    const principal = await this.requireUser(request, { mutation: true });
    this.database.client.transaction(() => {
      const user = this.mainAccount(); this.liveSession(principal.loginSessionId, user);
      const op = this.database.orm.select().from(s.accountOperations).where(eq(s.accountOperations.id, input.operationId)).get();
      if (!op || op.ownerId !== user.id || op.loginSessionId !== principal.loginSessionId || op.authVersion !== user.authVersion || !["pending", "old_verified", "cancelled"].includes(op.state)) throw new HttpError("ACCOUNT_OPERATION_INVALID");
      const at = this.now().toISOString(); this.database.orm.update(s.accountOperations).set({ state: "cancelled", invalidatedAt: at }).where(eq(s.accountOperations.id, op.id)).run();
      this.database.orm.update(s.emailChallenges).set({ invalidatedAt: at }).where(eq(s.emailChallenges.operationId, op.id)).run();
    }).immediate(); return { success: true };
  }
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
    const user = this.database.orm.select().from(s.users).where(eq(s.users.singleton, 1)).get();
    if (!user || !await verifyPassword(user.passwordHash, password)) throw new HttpError("AUTH_REQUIRED");
    const verifiedCode = this.database.orm.select().from(s.recoveryCodes).where(and(eq(s.recoveryCodes.ownerId, user.id), eq(s.recoveryCodes.codeHash, tokenHash(code)), isNull(s.recoveryCodes.usedAt))).get();
    if (!verifiedCode) throw new HttpError("AUTH_REQUIRED");
    const factor = totp(undefined, user.displayName); const recovery = newRecoveryCodes();
    const result = { displayName: user.displayName, totpSecret: factor.secret.base32, otpauthUri: factor.toString(), recoveryCodes: recovery };
    // 先持久保存新绑定资料，写盘失败不能使原验证器/恢复码失效。
    await persist?.(result);
    this.database.client.transaction(() => {
      this.snapshot(user, false);
      const consumed = this.database.orm.update(s.recoveryCodes).set({ usedAt: this.now().toISOString() }).where(and(eq(s.recoveryCodes.ownerId, user.id), eq(s.recoveryCodes.codeHash, tokenHash(code)), isNull(s.recoveryCodes.usedAt))).run();
      if (consumed.changes !== 1) throw new HttpError("AUTH_REQUIRED");
      this.database.orm.update(s.users).set({ totpCipher: encryptSecret(factor.secret.base32, this.key), totpEnabled: true, lastTotpCounter: -1,
        authMethod: "totp", authVersion: user.authVersion + 1, emailVerifiedAt: null }).where(eq(s.users.id, user.id)).run();
      const at = this.now().toISOString();
      this.invalidateAccount(user);
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
    database.orm.insert(s.categories).values({ id: randomUUID(), ownerId: id, name: "未分类", nameKey: "未分类", sortOrder: 0, isDefault: true, createdAt: at }).run();
    for (const code of recovery) database.orm.insert(s.recoveryCodes).values({ id: randomUUID(), ownerId: id, codeHash: tokenHash(code) }).run();
    database.orm.insert(s.auditEvents).values({ id: randomUUID(), ownerId: id, action: "account_initialized", createdAt: at }).run();
  }).immediate();
  return result;
}
