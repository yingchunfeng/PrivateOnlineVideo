import { HttpError } from "../../../core/errors.js";
import type { ByteRange } from "../../../core/contracts/index.js";

/** 单 Range；拒绝多范围、溢出、空范围。超出末端的合法终点按 RFC 截断。 */
export function parseRange(header: string | undefined, size: number): ByteRange | null {
  if (!Number.isSafeInteger(size) || size < 0) throw new HttpError("STORAGE_UNAVAILABLE");
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size === 0) throw new HttpError("RANGE_NOT_SATISFIABLE");
  const first = match[1] ? Number(match[1]) : null; const last = match[2] ? Number(match[2]) : null;
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) {
    throw new HttpError("RANGE_NOT_SATISFIABLE");
  }
  if (first === null) {
    if (!last || last < 1) throw new HttpError("RANGE_NOT_SATISFIABLE");
    return { start: Math.max(0, size - last), end: size - 1 };
  }
  if (first >= size || (last !== null && last < first)) throw new HttpError("RANGE_NOT_SATISFIABLE");
  return { start: first, end: Math.min(last ?? size - 1, size - 1) };
}
