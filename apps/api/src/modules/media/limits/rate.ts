import { HttpError } from "../../../core/errors.js";

/** 单机请求速率限制；传输字节额度和播放会话并发另由原子 Repository 负责。 */
export class RequestLimiter {
  private readonly windows = new Map<string, { at: number; count: number }>();
  constructor(readonly maximum: number) {}
  check(ownerId: string, group: string, now: number): void {
    for (const [key, value] of this.windows) if (now - value.at >= 60_000) this.windows.delete(key);
    const key = `${ownerId}:${group}`;
    let window = this.windows.get(key);
    if (!window) { window = { at: now, count: 0 }; this.windows.set(key, window); }
    if (++window.count > this.maximum) throw new HttpError("RATE_LIMITED");
  }
}
