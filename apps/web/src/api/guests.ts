import { GUEST_PERMISSIONS } from "@online-video/shared";
import type { CreateGuestRequest, GuestCredential, GuestList, GuestRecord, UpdateGuestRequest } from "@online-video/shared";
import { ApiClient, ApiError } from "./client";

function record(value: GuestRecord): GuestRecord {
  if (!value || typeof value.id !== "string" || !value.id || typeof value.name !== "string" || !value.name ||
    !Array.isArray(value.permissions) || !value.permissions.length || value.permissions.some(permission => !(GUEST_PERMISSIONS as readonly string[]).includes(permission)) ||
    ![value.createdAt, value.expiresAt, value.serverTime].every(time => typeof time === "string" && Number.isFinite(Date.parse(time))) ||
    !(value.revokedAt === null || typeof value.revokedAt === "string" && Number.isFinite(Date.parse(value.revokedAt))) ||
    !["active", "expired"].includes(value.status) || !Number.isSafeInteger(value.version) || value.version < 1) {
    throw new ApiError("INVALID_RESPONSE", "访客信息无法确认，请重新加载后核对");
  }
  return value;
}
function credential(value: GuestCredential): GuestCredential {
  if (!value || typeof value.password !== "string" || !value.password) throw new ApiError("INVALID_RESPONSE", "临时密码交付结果无法确认，请刷新后核对访客，必要时重置密码");
  record(value.guest); return value;
}
export const guestsApi = (client: ApiClient) => ({
  list: async () => {
    const value = await client.request<GuestList>("/api/guests");
    if (!value || !Array.isArray(value.items) || typeof value.persistenceAvailable !== "boolean" || !Number.isFinite(Date.parse(value.serverTime))) throw new ApiError("INVALID_RESPONSE", "访客列表无法读取，请重新加载");
    value.items.forEach(record); return value;
  },
  create: async (body: CreateGuestRequest) => credential(await client.request<GuestCredential>("/api/guests", { method: "POST", body })),
  update: async (id: string, body: UpdateGuestRequest) => record(await client.request<GuestRecord>(`/api/guests/${encodeURIComponent(id)}`, { method: "PATCH", body })),
  reset: async (id: string, version: number) => credential(await client.request<GuestCredential>(`/api/guests/${encodeURIComponent(id)}/reset`, { method: "POST", body: { version } })),
  revoke: async (id: string, version: number) => record(await client.request<GuestRecord>(`/api/guests/${encodeURIComponent(id)}/revoke`, { method: "POST", body: { version } }))
});
