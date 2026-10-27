import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { SetupLoginRequest, SetupPasswordRequest, SetupStatus } from "@online-video/shared";
import { HttpError } from "../../core/errors.js";
import type { AppDatabase } from "../../db/database.js";
import { AuthService } from "../auth/service.js";
import type { AuthSettings } from "../auth/settings.js";
import { csrfToken, encryptSecret, equalToken, hashPassword, randomToken, tokenHash, verifyPassword } from "../auth/crypto.js";
import { saveLoginMode } from "../auth/login-mode.js";
import { readInstallationState } from "./bootstrap.js";
import type { InstallationState } from "./bootstrap.js";

interface InstallationSession { id: string; token_hash: string; installation_version: number; expires_at: string; revoked_at: string | null }
interface SessionResult { token: string; expiresAt: string; data: SetupStatus }

export class SetupService {
  readonly cookieName: string;
  readonly sessionTtlMs = 30 * 60_000;
  private hashing = 0;
  constructor(readonly database: AppDatabase, readonly key: Buffer, readonly settings: AuthSettings, readonly auth: AuthService, readonly now: () => Date = () => new Date()) {
    this.cookieName = settings.secureCookie ? "__Host-ov_setup" : "ov_setup";
  }
  isReady(): boolean { const state = readInstallationState(this.database); return !state || state.stage === "ready"; }
  assertBusinessReady(): void { if (!this.isReady()) throw new HttpError("SETUP_REQUIRED"); }
  private state(): InstallationState {
    const state = readInstallationState(this.database);
    if (!state || state.stage === "ready") throw new HttpError("SETUP_ALREADY_COMPLETE");
    return state;
  }
  private session(request: FastifyRequest, state = this.state()) {
    const token = request.cookies?.[this.cookieName];
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError("AUTH_REQUIRED");
    const row = this.database.client.prepare("SELECT * FROM installation_sessions WHERE token_hash=?").get(tokenHash(token)) as InstallationSession | undefined;
    if (!row || row.revoked_at || row.expires_at <= this.now().toISOString() || row.installation_version !== state.version) throw new HttpError("SESSION_EXPIRED");
    return { token, row };
  }
  status(request?: FastifyRequest): SetupStatus {
    const state = readInstallationState(this.database);
    if (!state) return { stage: "ready", authenticated: false, setupAvailable: false };
    if (state.stage === "ready") return { stage: "ready", authenticated: false, setupAvailable: true };
    try {
      if (!request) throw new Error("no session");
      const { token } = this.session(request, state);
      return { stage: state.stage, authenticated: true, csrfToken: csrfToken(token, this.key), setupAvailable: true };
    } catch { return { stage: state.stage, authenticated: false, setupAvailable: true }; }
  }
  private mutation(request: FastifyRequest, state = this.state()) {
    this.auth.assertOrigin(request); const session = this.session(request, state);
    if (!equalToken(request.headers["x-csrf-token"], csrfToken(session.token, this.key))) throw new HttpError("CSRF_REJECTED");
    return session;
  }
  async requireConfigurationAccess(request: FastifyRequest, mutation: boolean): Promise<{ ownerId: string; setup: boolean }> {
    if (this.isReady()) { const principal = await this.auth.requireUser(request, { mutation }); return { ownerId: principal.user.id, setup: false }; }
    const state = this.state();
    if (state.stage !== "configuration" || !state.owner_id) throw new HttpError("SETUP_REQUIRED");
    if (mutation) this.mutation(request, state); else this.session(request, state);
    return { ownerId: state.owner_id, setup: true };
  }
  private attempt(ip: string): string[] {
    const keys = ["installation", `installation:${tokenHash(ip)}`]; const now = this.now().getTime();
    this.database.client.transaction(() => {
      for (const key of keys) {
        const row = this.database.client.prepare("SELECT window_start,failures FROM login_attempts WHERE key=?").get(key) as { window_start: number; failures: number } | undefined;
        const failures = row && now - row.window_start < this.settings.failureWindowMs ? row.failures : 0;
        if (failures >= this.settings.maxFailures) throw new HttpError("RATE_LIMITED");
        this.database.client.prepare("INSERT INTO login_attempts(key,window_start,failures) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET window_start=excluded.window_start,failures=excluded.failures")
          .run(key, failures ? row!.window_start : now, failures + 1);
      }
    }).immediate(); return keys;
  }
  private issue(state: InstallationState): SessionResult {
    const token = randomToken(); const expiresAt = new Date(this.now().getTime() + this.sessionTtlMs).toISOString();
    this.database.client.prepare("INSERT INTO installation_sessions(id,token_hash,installation_version,created_at,expires_at) VALUES(?,?,?,?,?)")
      .run(randomUUID(), tokenHash(token), state.version, this.now().toISOString(), expiresAt);
    return { token, expiresAt, data: { stage: state.stage, authenticated: true, csrfToken: csrfToken(token, this.key), setupAvailable: true } };
  }
  async login(request: FastifyRequest, input: SetupLoginRequest): Promise<SessionResult> {
    this.auth.assertOrigin(request); const state = this.state();
    if (this.hashing >= 2) throw new HttpError("RATE_LIMITED");
    const keys = this.attempt(request.ip); this.hashing++;
    try {
      if (state.stage === "password") {
        if (input.password !== "adminadmin" || !input.installationCode || !/^[A-Za-z0-9_-]{43}$/.test(input.installationCode) || !equalToken(tokenHash(input.installationCode), state.installation_code_hash))
          throw new HttpError("INSTALLATION_CODE_INVALID");
      } else {
        const user = this.database.client.prepare("SELECT password_hash FROM users WHERE id=?").get(state.owner_id) as { password_hash: string } | undefined;
        if (!user || !await verifyPassword(user.password_hash, input.password)) throw new HttpError("INVALID_CREDENTIALS");
      }
      return this.database.client.transaction(() => {
        const current = this.state(); if (current.version !== state.version) throw new HttpError("ACCOUNT_VERSION_CONFLICT");
        for (const key of keys) this.database.client.prepare("UPDATE login_attempts SET failures=0 WHERE key=?").run(key);
        return this.issue(current);
      }).immediate();
    } finally { this.hashing--; }
  }
  async password(request: FastifyRequest, input: SetupPasswordRequest): Promise<SessionResult> {
    const state = this.state(); if (state.stage !== "password") throw new HttpError("ACCOUNT_VERSION_CONFLICT");
    const original = this.mutation(request, state);
    if (input.newPassword.length < 12 || input.newPassword.length > 128 || input.newPassword !== input.confirmPassword || input.newPassword === "adminadmin") throw new HttpError("PASSWORD_POLICY_FAILED");
    if (this.hashing >= 2) throw new HttpError("RATE_LIMITED"); this.hashing++;
    try {
      const passwordHash = await hashPassword(input.newPassword); const ownerId = randomUUID(); const at = this.now().toISOString();
      return this.database.client.transaction(() => {
        const current = this.state();
        if (current.version !== state.version || current.stage !== "password") throw new HttpError("ACCOUNT_VERSION_CONFLICT");
        const session = this.session(request, current); if (session.row.id !== original.row.id) throw new HttpError("SESSION_EXPIRED");
        if ((this.database.client.prepare("SELECT count(*) n FROM users").get() as { n: number }).n) throw new HttpError("ACCOUNT_VERSION_CONFLICT");
        this.database.client.prepare("INSERT INTO users(id,display_name,password_hash,totp_cipher,totp_enabled,created_at) VALUES(?,?,?,?,0,?)")
          .run(ownerId, "管理员", passwordHash, encryptSecret(randomToken(), this.key), at);
        saveLoginMode(this.database, ownerId, "password", at);
        this.database.client.prepare("INSERT INTO categories(id,owner_id,name,name_key,is_default,created_at) VALUES(?,?,?, ?,1,?)").run(randomUUID(), ownerId, "未分类", "未分类", at);
        this.database.client.prepare("UPDATE installation_state SET stage='configuration',owner_id=?,version=version+1,installation_code_hash='' WHERE id=1 AND version=?").run(ownerId, state.version);
        this.database.client.prepare("UPDATE installation_sessions SET revoked_at=? WHERE revoked_at IS NULL").run(at);
        this.database.client.prepare("INSERT INTO audit_events(id,owner_id,action,created_at) VALUES(?,?,?,?)").run(randomUUID(), ownerId, "installation_password_changed", at);
        return this.issue(this.state());
      }).immediate();
    } finally { this.hashing--; }
  }
  async complete(request: FastifyRequest, validate: () => Promise<void>): Promise<{ success: true }> {
    const state = this.state(); if (state.stage !== "configuration") throw new HttpError("SETUP_REQUIRED");
    const original = this.mutation(request, state);
    const settingsVersion = () => (this.database.client.prepare("SELECT version FROM installation_settings WHERE id=1").get() as { version: number } | undefined)?.version ?? null;
    const expectedSettingsVersion = settingsVersion(); await validate();
    this.database.client.transaction(() => {
      const current = this.state(); if (current.version !== state.version) throw new HttpError("ACCOUNT_VERSION_CONFLICT");
      if (settingsVersion() !== expectedSettingsVersion) throw new HttpError("CONFIG_VERSION_CONFLICT");
      const session = this.session(request, current); if (session.row.id !== original.row.id) throw new HttpError("SESSION_EXPIRED");
      const at = this.now().toISOString();
      this.database.client.prepare("UPDATE installation_state SET stage='ready',version=version+1,completed_at=? WHERE id=1 AND version=?").run(at, state.version);
      this.database.client.prepare("UPDATE installation_sessions SET revoked_at=? WHERE revoked_at IS NULL").run(at);
      this.database.client.prepare("INSERT INTO audit_events(id,owner_id,action,created_at) VALUES(?,?,?,?)").run(randomUUID(), current.owner_id, "installation_completed", at);
    }).immediate(); return { success: true };
  }
  logout(request: FastifyRequest): { success: true } {
    const { row } = this.mutation(request);
    this.database.client.prepare("UPDATE installation_sessions SET revoked_at=? WHERE id=?").run(this.now().toISOString(), row.id);
    return { success: true };
  }
}
