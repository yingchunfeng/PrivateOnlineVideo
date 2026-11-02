import { randomUUID } from "node:crypto";
import { GUEST_PERMISSIONS } from "@online-video/shared";
import type { CreateGuestRequest, GuestAccess, GuestCredential, GuestList, GuestPermission, GuestRecord, UpdateGuestRequest } from "@online-video/shared";
import type { AppDatabase } from "../../db/database.js";
import { HttpError } from "../../core/errors.js";
import { hashPassword, randomToken, verifyPassword } from "../auth/crypto.js";

export interface GuestRow {
  id: string; owner_id: string; name: string; password_hash: string; permissions: string;
  expires_at: string; revoked_at: string | null; created_at: string; version: number;
}
const pagePermissions: GuestPermission[] = ["library", "upload", "pages", "tasks", "configuration"];

export class GuestService {
  private readonly listeners = new Set<(guestId: string) => void>();
  private hashing = 0;
  constructor(readonly database: AppDatabase, readonly now: () => Date = () => new Date()) {}
  available(): boolean {
    return (this.database.client.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN ('guests','guest_sessions','guest_uploads')").get() as { n: number }).n === 3;
  }
  private requireAvailable(): void { if (!this.available()) throw new HttpError("GUEST_UNAVAILABLE"); }
  onChange(listener: (guestId: string) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed(id: string): void {
    for (const listener of this.listeners) { try { listener(id); } catch { /* 请求失效通知不能回滚已经提交的凭证变更。 */ } }
  }
  private row(id: string, ownerId?: string): GuestRow | undefined {
    this.requireAvailable();
    return (ownerId ? this.database.client.prepare("SELECT * FROM guests WHERE id=? AND owner_id=?").get(id, ownerId)
      : this.database.client.prepare("SELECT * FROM guests WHERE id=?").get(id)) as GuestRow | undefined;
  }
  private permissions(row: GuestRow): GuestPermission[] {
    try {
      const value: unknown = JSON.parse(row.permissions);
      if (!Array.isArray(value) || !value.length || value.some(item => !(GUEST_PERMISSIONS as readonly unknown[]).includes(item))) throw new Error("invalid permissions");
      return value as GuestPermission[];
    } catch { throw new HttpError("GUEST_EXPIRED"); }
  }
  private active(row: GuestRow | undefined): GuestRow {
    if (!row || row.revoked_at || row.expires_at <= this.now().toISOString()) throw new HttpError("GUEST_EXPIRED");
    return row;
  }
  private access(row: GuestRow): GuestAccess {
    return { id: row.id, name: row.name, permissions: this.permissions(row), expiresAt: row.expires_at, serverTime: this.now().toISOString() };
  }
  private record(row: GuestRow): GuestRecord {
    return { ...this.access(row), createdAt: row.created_at, revokedAt: row.revoked_at,
      status: row.revoked_at || row.expires_at <= this.now().toISOString() ? "expired" : "active", version: row.version };
  }
  assertActive(guestId: string): GuestAccess { return this.access(this.active(this.row(guestId))); }
  accessForSession(loginSessionId: string): GuestAccess | null {
    if (!this.available()) return null;
    const link = this.database.client.prepare("SELECT guest_id FROM guest_sessions WHERE login_session_id=?").get(loginSessionId) as { guest_id: string } | undefined;
    if (!link) return null;
    const session = this.database.client.prepare("SELECT l.owner_id,l.expires_at,l.revoked_at,l.auth_version,u.auth_version current_version FROM login_sessions l JOIN users u ON u.id=l.owner_id WHERE l.id=?")
      .get(loginSessionId) as { owner_id: string; expires_at: string; revoked_at: string | null; auth_version: number; current_version: number } | undefined;
    const row = this.active(this.row(link.guest_id));
    if (!session || session.owner_id !== row.owner_id || session.revoked_at || session.expires_at <= this.now().toISOString() || session.auth_version !== session.current_version) throw new HttpError("GUEST_EXPIRED");
    return this.access(row);
  }
  list(ownerId: string): GuestList {
    const persistenceAvailable = this.available();
    return { persistenceAvailable, serverTime: this.now().toISOString(), items: persistenceAvailable
      ? (this.database.client.prepare("SELECT * FROM guests WHERE owner_id=? ORDER BY created_at DESC,id").all(ownerId) as GuestRow[]).map(row => this.record(row)) : [] };
  }
  private validate(input: CreateGuestRequest): CreateGuestRequest {
    if (!input || typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 40 || /[\u0000-\u001f\u007f]/.test(input.name) ||
      typeof input.expiresAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(input.expiresAt)) throw new HttpError("VALIDATION_ERROR");
    const time = Date.parse(input.expiresAt);
    if (!Number.isFinite(time) || time <= this.now().getTime() || time > 253402300799999) throw new HttpError("VALIDATION_ERROR");
    if (!Array.isArray(input.permissions) || !input.permissions.length || input.permissions.length > GUEST_PERMISSIONS.length ||
      input.permissions.some(value => !(GUEST_PERMISSIONS as readonly unknown[]).includes(value)) || new Set(input.permissions).size !== input.permissions.length ||
      !input.permissions.some(value => pagePermissions.includes(value)) ||
      (input.permissions.includes("video_edit") || input.permissions.includes("video_delete")) && !input.permissions.includes("library")) throw new HttpError("VALIDATION_ERROR");
    return { name: input.name.trim(), expiresAt: new Date(time).toISOString(), permissions: [...input.permissions] };
  }
  private expected(id: string, ownerId: string, version: number): GuestRow {
    if (!Number.isSafeInteger(version) || version < 1) throw new HttpError("VALIDATION_ERROR");
    const row = this.row(id, ownerId); if (!row) throw new HttpError("NOT_FOUND");
    if (row.version !== version) throw new HttpError("GUEST_VERSION_CONFLICT");
    return row;
  }
  private audit(ownerId: string, action: string, guestId: string): void {
    this.database.client.prepare("INSERT INTO audit_events(id,owner_id,action,created_at) VALUES(?,?,?,?)")
      .run(randomUUID(), ownerId, `${action}:${guestId}`, this.now().toISOString());
  }
  private async hash(password: string): Promise<string> {
    if (this.hashing >= 2) throw new HttpError("RATE_LIMITED");
    this.hashing++;
    try { return await hashPassword(password); } finally { this.hashing--; }
  }
  async create(ownerId: string, input: CreateGuestRequest, authorize: () => Promise<unknown>): Promise<GuestCredential> {
    this.requireAvailable(); const value = this.validate(input); const id = randomUUID(); const password = `${id}.${randomToken()}`;
    const digest = await this.hash(password); await authorize();
    return this.database.client.transaction(() => {
      this.validate(value);
      this.database.client.prepare("INSERT INTO guests(id,owner_id,name,password_hash,permissions,expires_at,created_at) VALUES(?,?,?,?,?,?,?)")
        .run(id, ownerId, value.name, digest, JSON.stringify(value.permissions), value.expiresAt, this.now().toISOString());
      this.audit(ownerId, "guest_created", id);
      return { guest: this.record(this.row(id, ownerId)!), password };
    }).immediate();
  }
  update(ownerId: string, id: string, input: UpdateGuestRequest): GuestRecord {
    const value = this.validate(input);
    const result = this.database.client.transaction(() => {
      this.active(this.expected(id, ownerId, input.version));
      this.database.client.prepare("UPDATE guests SET name=?,permissions=?,expires_at=?,version=version+1 WHERE id=? AND owner_id=? AND version=?")
        .run(value.name, JSON.stringify(value.permissions), value.expiresAt, id, ownerId, input.version);
      this.database.client.prepare("UPDATE login_sessions SET expires_at=min(expires_at,?) WHERE id IN (SELECT login_session_id FROM guest_sessions WHERE guest_id=?)")
        .run(value.expiresAt, id);
      this.audit(ownerId, "guest_updated", id); return this.record(this.row(id, ownerId)!);
    }).immediate();
    this.changed(id); return result;
  }
  private revokeSessions(id: string): void {
    const at = this.now().toISOString();
    this.database.client.prepare("UPDATE login_sessions SET revoked_at=? WHERE revoked_at IS NULL AND id IN (SELECT login_session_id FROM guest_sessions WHERE guest_id=?)").run(at, id);
    this.database.client.prepare("UPDATE playback_sessions SET closed_at=? WHERE closed_at IS NULL AND login_session_id IN (SELECT login_session_id FROM guest_sessions WHERE guest_id=?)").run(at, id);
  }
  async reset(ownerId: string, id: string, version: number, authorize: () => Promise<unknown>): Promise<GuestCredential> {
    this.active(this.expected(id, ownerId, version)); const password = `${id}.${randomToken()}`;
    const digest = await this.hash(password); await authorize();
    const guest = this.database.client.transaction(() => {
      this.active(this.expected(id, ownerId, version));
      this.database.client.prepare("UPDATE guests SET password_hash=?,version=version+1 WHERE id=? AND owner_id=? AND version=?").run(digest, id, ownerId, version);
      this.revokeSessions(id); this.audit(ownerId, "guest_password_reset", id); return this.record(this.row(id, ownerId)!);
    }).immediate();
    this.changed(id); return { guest, password };
  }
  revoke(ownerId: string, id: string, version: number): GuestRecord {
    const result = this.database.client.transaction(() => {
      const row = this.expected(id, ownerId, version);
      if (!row.revoked_at) this.database.client.prepare("UPDATE guests SET revoked_at=?,version=version+1 WHERE id=? AND owner_id=? AND version=?")
        .run(this.now().toISOString(), id, ownerId, version);
      this.revokeSessions(id); this.audit(ownerId, "guest_revoked", id); return this.record(this.row(id, ownerId)!);
    }).immediate();
    this.changed(id); return result;
  }
  async verifyLogin(password: string): Promise<GuestRow> {
    this.requireAvailable();
    const match = /^([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.[A-Za-z0-9_-]{43}$/.exec(password);
    const row = match ? this.row(match[1]!) : undefined;
    if (!row || !await verifyPassword(row.password_hash, password)) throw new HttpError("INVALID_CREDENTIALS");
    if (row.revoked_at || row.expires_at <= this.now().toISOString()) throw new HttpError("INVALID_CREDENTIALS");
    return row;
  }
  confirmLogin(expected: GuestRow): GuestAccess {
    const row = this.row(expected.id, expected.owner_id);
    if (!row || row.version !== expected.version || row.password_hash !== expected.password_hash || row.revoked_at || row.expires_at <= this.now().toISOString()) throw new HttpError("INVALID_CREDENTIALS");
    return this.access(row);
  }
}
