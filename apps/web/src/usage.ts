import type { ApplicationUsage } from "@online-video/shared";
import { ApiError } from "./api/client";

export type UsagePresentation = { kind: "limited"; remaining: number; reached: boolean; ratio: number } | { kind: "unlimited" | "unconfigured" | "oss_unknown" };
export function presentUsage(usage: ApplicationUsage): UsagePresentation {
  if (!Number.isSafeInteger(usage.activePlaybackSessions) || usage.activePlaybackSessions < 0 || !Number.isFinite(Date.parse(usage.periodStart)) || !Number.isFinite(Date.parse(usage.periodEnd)) || Date.parse(usage.periodStart) >= Date.parse(usage.periodEnd)) throw new ApiError("INVALID_RESPONSE", "应用用量来源或统计字段无法确认，不能计算剩余额度");
  try { new Intl.DateTimeFormat("zh-CN", { timeZone: usage.timezone }).format(); } catch { throw new ApiError("INVALID_RESPONSE", "统计时区无法确认"); }
  if (usage.source === "oss_direct") {
    if (usage.statisticsStatus !== "not_synced" || usage.transferredBytes !== null || usage.cloudStatisticsAt !== null || usage.limitMode !== "not_applicable" || usage.limitBytes !== null || [usage.authorizationCount, usage.playbackAuthorizationCount, usage.renewalAuthorizationCount, usage.downloadAuthorizationCount].some(value => !Number.isSafeInteger(value) || value < 0)) throw new ApiError("INVALID_RESPONSE", "OSS 直连统计状态无效，不能当作实际传输量");
    return { kind: "oss_unknown" };
  }
  if (usage.source !== "application_proxy" || !Number.isSafeInteger(usage.transferredBytes) || usage.transferredBytes < 0) throw new ApiError("INVALID_RESPONSE", "应用用量来源或统计字段无法确认，不能计算剩余额度");
  if (usage.limitMode === "limited") {
    if (!Number.isSafeInteger(usage.limitBytes) || usage.limitBytes < 0) throw new ApiError("INVALID_RESPONSE", "限额数字无效，不能计算剩余额度");
    return { kind: "limited", remaining: Math.max(0, usage.limitBytes - usage.transferredBytes), reached: usage.transferredBytes >= usage.limitBytes, ratio: usage.limitBytes === 0 ? 1 : Math.min(1, usage.transferredBytes / usage.limitBytes) };
  }
  if ((usage.limitMode === "unlimited" || usage.limitMode === "unconfigured") && usage.limitBytes === null) return { kind: usage.limitMode };
  throw new ApiError("INVALID_RESPONSE", "无法识别限额状态，请检查服务端配置");
}
