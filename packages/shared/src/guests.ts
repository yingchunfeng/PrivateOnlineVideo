export const GUEST_PERMISSIONS = ["library", "upload", "pages", "tasks", "configuration", "video_edit", "video_delete"] as const;
export type GuestPermission = typeof GUEST_PERMISSIONS[number];
export const GUEST_DEFAULT_PERMISSIONS: GuestPermission[] = ["library", "upload", "pages"];
export const GUEST_PERMISSION_LABELS: Record<GuestPermission, string> = {
  library: "首页库", upload: "上传视频", pages: "页面管理（个人外观）", tasks: "任务列表（本人任务）",
  configuration: "配置管理（共享分类和标签）", video_edit: "编辑视频（含封面和时长补采）", video_delete: "仅删除视频数据库记录"
};
export interface GuestAccess { id: string; name: string; permissions: GuestPermission[]; expiresAt: string; serverTime: string }
export interface GuestRecord extends GuestAccess { createdAt: string; revokedAt: string | null; status: "active" | "expired"; version: number }
export interface GuestList { items: GuestRecord[]; serverTime: string; persistenceAvailable: boolean }
export interface CreateGuestRequest { name: string; expiresAt: string; permissions: GuestPermission[] }
export interface UpdateGuestRequest extends CreateGuestRequest { version: number }
export interface GuestCredential { guest: GuestRecord; password: string }
