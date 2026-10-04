import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { EmailChallenge, EmailChallengePurpose } from "@online-video/shared";
import { buildApp } from "../../src/app.js";
import { readConfig } from "../../src/core/config.js";
import { openDatabase } from "../../src/db/database.js";
import { AuthService, initializeAccount } from "../../src/modules/auth/service.js";
import { readAuthSettings } from "../../src/modules/auth/settings.js";
import { totp } from "../../src/modules/auth/crypto.js";
import type { MailMessage, MailSender } from "../../src/modules/auth/mail.js";

export class FakeMailSender implements MailSender {
  readonly messages: MailMessage[] = [];
  failVerification = false;
  failNotification = false;
  beforeSend: ((message: MailMessage) => Promise<void>) | undefined;
  async send(message: MailMessage): Promise<void> {
    this.messages.push(message);
    await this.beforeSend?.(message);
    if ((message.kind === "verification" && this.failVerification) || (message.kind === "notification" && this.failNotification)) throw new Error("isolated mail failure");
  }
  verification(challengeId: string) {
    const message = [...this.messages].reverse().find(message => message.kind === "verification" && message.challengeId === challengeId);
    assert.ok(message?.kind === "verification", "Fake 邮件中没有挑战验证码");
    return message;
  }
  latest(purpose: EmailChallengePurpose) {
    const message = [...this.messages].reverse().find(message => message.kind === "verification" && message.purpose === purpose);
    assert.ok(message?.kind === "verification", `Fake 邮件中没有 ${purpose} 验证码`);
    return message;
  }
}
export async function accountFixture(options: { path?: string; initialize?: boolean; sender?: FakeMailSender; settings?: Record<string, string> } = {}) {
  const database = openDatabase(options.path ?? ":memory:", { initialize: options.initialize ?? true });
  const key = randomBytes(32); const credentials = await initializeAccount(database, key, "隔离账号验收");
  const clock = { at: new Date("2026-10-04T10:00:00.000Z") }; const now = () => clock.at;
  const sender = options.sender ?? new FakeMailSender();
  const settings = readAuthSettings("test", { AUTH_MAX_FAILURES: "100", ...options.settings });
  const auth = new AuthService(database, key, settings, now, sender);
  const config = readConfig({ NODE_ENV: "test" });
  const app = await buildApp({ config, auth, logger: false });
  const origin = settings.allowedOrigins[0]!;
  let cookie = ""; let csrf = "";
  const headers = () => ({ origin, ...(cookie ? { cookie, "x-csrf-token": csrf } : {}) });
  const call = async (url: string, payload?: unknown, custom?: Record<string, string>) => app.inject({ url, method: payload === undefined ? "GET" : "POST", headers: { ...(custom ?? headers()), ...(payload === undefined ? {} : { "content-type": "application/json" }) }, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) });
  const ok = async <T>(url: string, payload?: unknown): Promise<T> => {
    const response = await call(url, payload); assert.equal(response.statusCode, 200, `${url}: ${response.body}`);
    return response.json<{ data: T }>().data;
  };
  const token = (secret = credentials.totpSecret) => totp(secret).generate({ timestamp: clock.at.getTime() });
  const advance = (ms = 60_001) => { clock.at = new Date(clock.at.getTime() + ms); };
  const saveLogin = (response: Awaited<ReturnType<typeof call>>) => {
    assert.equal(response.statusCode, 200, response.body);
    cookie = String(response.headers["set-cookie"]).split(";")[0]!; csrf = response.json<{ data: { csrfToken: string } }>().data.csrfToken;
  };
  const loginTotp = async (secret = credentials.totpSecret) => saveLogin(await call("/api/auth/login", { password: credentials.password, totp: token(secret) }));
  const loginEmail = async (password = credentials.password) => {
    const challenge = await ok<EmailChallenge>("/api/auth/login/code", { password });
    saveLogin(await call("/api/auth/login", { authMethod: "email", password, challengeId: challenge.challengeId, code: sender.verification(challenge.challengeId).code }));
  };
  const bind = async (email = "owner@qq.com", secret = credentials.totpSecret) => {
    advance(30_001);
    const challenge = await ok<EmailChallenge>("/api/auth/email/bind/code", { currentPassword: credentials.password, totp: token(secret), email });
    await ok("/api/auth/email/bind/confirm", { currentPassword: credentials.password, totp: token(secret), operationId: challenge.operationId, challengeId: challenge.challengeId, code: sender.verification(challenge.challengeId).code });
    return challenge;
  };
  const user = () => database.client.prepare("SELECT * FROM users").get() as Record<string, unknown>;
  return { database, key, credentials, clock, now, sender, settings, auth, config, app, origin, call, ok, token, advance, saveLogin, loginTotp, loginEmail, bind, user, headers, close: async () => { await app.close(); if (database.client.open) database.close(); } };
}
