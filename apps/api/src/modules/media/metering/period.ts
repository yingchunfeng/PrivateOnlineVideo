import type { UsagePeriod } from "../../../core/contracts/index.js";

/** 按 IANA 本地日期定位真实 UTC 日边界，包含 DST 的 23/25 小时统计日。 */
export function usagePeriod(now: Date, timezone: string): UsagePeriod {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  const dateKey = (at: number) => {
    const parts = formatter.formatToParts(new Date(at));
    return ["year", "month", "day"].map(type => parts.find(part => part.type === type)!.value).join("-");
  };
  const current = dateKey(now.getTime());
  const boundary = (lower: number, upper: number, after: boolean) => {
    while (upper - lower > 1) {
      const middle = Math.floor((lower + upper) / 2);
      if (after ? dateKey(middle) <= current : dateKey(middle) < current) lower = middle; else upper = middle;
    }
    return upper;
  };
  const radius = 48 * 60 * 60 * 1000;
  return { start: new Date(boundary(now.getTime() - radius, now.getTime(), false)).toISOString(),
    end: new Date(boundary(now.getTime(), now.getTime() + radius, true)).toISOString(), timezone };
}
