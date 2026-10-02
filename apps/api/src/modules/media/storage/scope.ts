import { HttpError } from "../../../core/errors.js";
import type { StorageObjectRef } from "../../../core/contracts/index.js";

/** 不对用户输入解码或规范化：歧义路径直接拒绝，授权前缀必须有目录边界。 */
export class ObjectScope {
  readonly prefix: string;
  constructor(prefix: string) {
    if (!prefix.endsWith("/") || !ObjectScope.valid(prefix)) throw new HttpError("SERVICE_NOT_CONFIGURED");
    this.prefix = prefix;
  }
  private static valid(value: string): boolean {
    return value.length > 0 && value.length <= 1024 && !value.startsWith("/") &&
      !/[\\\x00-\x1f\x7f%?#]/.test(value) && !value.split("/").some(part => part === "." || part === "..");
  }
  key(object: StorageObjectRef): string {
    if (!ObjectScope.valid(object.key) || !object.key.startsWith(this.prefix) || object.key === this.prefix) {
      throw new HttpError("FORBIDDEN");
    }
    return object.key;
  }
  subprefix(prefix: string): string {
    if (!ObjectScope.valid(prefix) || !prefix.endsWith("/") || !prefix.startsWith(this.prefix)) {
      throw new HttpError("FORBIDDEN");
    }
    return prefix;
  }
}

export function checkAborted(signal: AbortSignal): void { signal.throwIfAborted(); }
