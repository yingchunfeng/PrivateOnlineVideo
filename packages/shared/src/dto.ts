import type { EmailProviderType } from "./email.js";

/** 输出时间统一为 UTC ISO 8601，例如 2026-10-01T10:00:00.000Z。 */
export type IsoDateTime = string;
/** Bytes 是非负安全整数，1 byte = 1 字节；秒数允许非负小数。 */
export type Bytes = number;
export type ResourceId = string;
export type ApiPath = `/api/${string}`;
export const PLAYBACK_MODE = "proxy" as const;
export type PlaybackMode = "proxy" | "oss";
export const VIDEO_STATUSES = ["processing", "ready", "unsupported", "failed"] as const;
export type VideoStatus = typeof VIDEO_STATUSES[number];
export const UPLOAD_STATUSES = ["uploading", "finalizing", "completed", "failed"] as const;
export type UploadStatus = typeof UPLOAD_STATUSES[number];
export interface ApiResponse<T> { data: T }
export interface Page<T> { items: T[]; page: number; pageSize: number; total: number }
export interface PaginationQuery { page?: number; pageSize?: number }
export type AuthMethod = "password" | "totp" | "email";
export interface CurrentUser { id: ResourceId; displayName: string; totpEnabled: boolean; authMethod: AuthMethod; authVersion: number; emailMasked: string | null; emailVerified: boolean; role?: "admin" | "guest" }
export interface Category { id: ResourceId; name: string; sortOrder: number; isDefault?: boolean; archivedAt?: IsoDateTime | null }
export interface LibraryGroup { id: ResourceId; name: string; description: string; sortOrder: number; createdAt: IsoDateTime; updatedAt: IsoDateTime; archivedAt: IsoDateTime | null }
export interface Tag { id: ResourceId; name: string; createdAt: IsoDateTime; updatedAt: IsoDateTime; archivedAt: IsoDateTime | null }
export interface LibraryTagDefinition { id: ResourceId; name: string; enabled?: boolean }
export interface LibraryCategory { id: ResourceId; name: string; tags: string[]; tagIds?: ResourceId[]; enabled?: boolean }
export interface LibraryConfig { mediaBaseUrl: string; objectPrefix: string; categories: LibraryCategory[]; tagDefinitions?: LibraryTagDefinition[] }
export interface LibraryConfigurationCategory { id: ResourceId; name: string; enabled: boolean; tagIds: ResourceId[]; isDefault: boolean; videoCount: number; uploadCount: number }
export interface LibraryConfigurationTag { id: ResourceId; name: string; enabled: boolean; categoryIds: ResourceId[]; videoCount: number; uploadCount: number }
export interface LibraryConfiguration { version: string; categories: LibraryConfigurationCategory[]; tags: LibraryConfigurationTag[]; writable: boolean }
/** 新增项不提交 id；已有项保留 id，业务删除使用 enabled:false。 */
export interface SaveLibraryConfigurationRequest { version: string; categories: { id?: ResourceId; name: string; enabled: boolean; tagIds: ResourceId[] }[]; tags: { id?: ResourceId; name: string; enabled: boolean }[]; confirmImpact?: boolean }
export type LibraryConfigurationResponse = ApiResponse<LibraryConfiguration>;
export type LibraryConfigResponse = ApiResponse<LibraryConfig>;
export interface OrganizationSelection { categoryId: ResourceId; groupIds?: ResourceId[]; tagIds?: ResourceId[] }
export const MAX_ORGANIZATION_LINKS = 20;
export interface VideoSummary {
  id: ResourceId;
  title: string;
  categoryId: ResourceId;
  groupIds?: ResourceId[];
  tagIds?: ResourceId[];
  tags?: string[];
  objectKey?: string;
  publicUrl?: string;
  fileName?: string;
  coverObjectKey?: string | null;
  coverUrl?: string | null;
  coverStatus?: CoverStatus;
  durationSeconds: number | null;
  sizeBytes: Bytes;
  status: VideoStatus;
  thumbnailUrl: ApiPath | null;
  createdAt: IsoDateTime;
}
export interface VideoDetail extends VideoSummary {
  codec: string | null;
  width: number | null;
  height: number | null;
  playable: boolean;
  lastPositionSeconds: number;
}
interface PlaybackSessionBase {
  id: ResourceId;
  videoId: ResourceId;
  expiresAt: IsoDateTime;
}
export type PlaybackSession = PlaybackSessionBase & (
  | { mode: "proxy"; sourceUrl: ApiPath }
  | { mode: "oss"; sourceUrl: string; sourceExpiresAt: IsoDateTime; renewAfter: IsoDateTime }
);
export type PlaybackSource = PlaybackSession;
export interface DownloadAuthorization { videoId: ResourceId; mode: "oss"; sourceUrl: string; sourceExpiresAt: IsoDateTime; fileName: string }
/** SHA-256 对原始分片字节计算，64 位小写十六进制；运行时必须校验。 */
export type PartChecksum = string;
export const PART_CHECKSUM_ALGORITHM = "SHA-256" as const;
export const PART_CHECKSUM_ENCODING = "hex-lowercase" as const;
export const PART_CHECKSUM_HEADER = "x-part-checksum" as const;
export function isPartChecksum(value: unknown): value is PartChecksum {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
export interface UploadedPart { partNumber: number; sizeBytes: Bytes; checksum: PartChecksum }
export interface UploadTask {
  id: ResourceId;
  videoId: ResourceId | null;
  fileName: string;
  sizeBytes: Bytes;
  partSizeBytes: Bytes;
  status: UploadStatus;
  uploadedParts: UploadedPart[];
  createdAt: IsoDateTime;
  title?: string;
  categoryId?: ResourceId;
  groupIds?: ResourceId[];
  tagIds?: ResourceId[];
  tags?: string[];
  clientRequestId?: string;
  objectKey?: string;
  publicUrl?: string;
  uploadedBytes?: Bytes;
  errorCode?: string | null;
  coverObjectKey?: string | null;
  coverUrl?: string | null;
  coverStatus?: CoverStatus;
}
export type CoverStatus = "missing" | "saving" | "saved" | "failed";
export interface UploadListQuery extends PaginationQuery { status?: UploadStatus }
export type UploadsResponse = ApiResponse<Page<UploadTask>>;
export type CoverResponse = ApiResponse<VideoDetail>;
export type TransferPolicy =
  | { kind: "unconfigured" }
  | { kind: "limited"; limitBytes: Bytes }
  | { kind: "unlimited" };
interface UsageBase {
  periodStart: IsoDateTime;
  periodEnd: IsoDateTime;
  timezone: string;
  transferredBytes: Bytes;
  activePlaybackSessions: number;
  source: "application_proxy";
}
/** null 由 limitMode 消歧：未配置必须阻止传输，只有明确 unlimited 才允许不限额。 */
export type ProxyApplicationUsage = UsageBase & (
  | { limitMode: "limited"; limitBytes: Bytes }
  | { limitMode: "unconfigured" | "unlimited"; limitBytes: null }
);
export interface OssApplicationUsage {
  source: "oss_direct";
  statisticsStatus: "not_synced";
  periodStart: IsoDateTime; periodEnd: IsoDateTime; timezone: string;
  transferredBytes: null; cloudStatisticsAt: null;
  limitMode: "not_applicable"; limitBytes: null;
  activePlaybackSessions: number; authorizationCount: number;
  playbackAuthorizationCount: number; renewalAuthorizationCount: number; downloadAuthorizationCount: number;
}
export type ApplicationUsage = ProxyApplicationUsage | OssApplicationUsage;
export interface LoginSession {
  id: ResourceId;
  createdAt: IsoDateTime;
  lastSeenAt: IsoDateTime;
  expiresAt: IsoDateTime;
  isCurrent: boolean;
}
export interface AuthSession { user: CurrentUser; csrfToken: string; defaultTheme?: "light" | "dark"; guest?: import("./guests.js").GuestAccess }
export interface WatchProgress {
  videoId: ResourceId;
  positionSeconds: number;
  updatedAt: IsoDateTime | null;
}
export interface ImportPreviewItem {
  id: ResourceId;
  fileName: string;
  sizeBytes: Bytes;
  durationSeconds: number | null;
  codec: string | null;
}
export interface ImportPreview { id: ResourceId; items: ImportPreviewItem[]; expiresAt: IsoDateTime; nextCursor?: string | null }

export interface HealthData { status: "ok" }
export type HealthResponse = ApiResponse<HealthData>;
/** 无 authMethod 的旧请求仅在账号处于 TOTP 模式时兼容。 */
export type LoginRequest =
  | { authMethod: "password"; password: string; totp?: never; challengeId?: never; code?: never }
  | { authMethod?: "totp"; password: string; totp: string; challengeId?: never; code?: never }
  | { authMethod: "email"; password: string; challengeId: ResourceId; code: string; totp?: never };
/** 未登录摘要不披露邮箱；密码验证通过后的发码响应才返回脱敏邮箱。 */
export interface LoginOptions { authMethod: AuthMethod; serverTime: IsoDateTime; emailProviders: EmailProviderType[] }
export interface LoginCodeRequest { password: string }
export type EmailChallengePurpose = "login" | "bind_email" | "change_password" | "change_email_old" | "change_email_new" | "email_verification";
export interface EmailChallenge { challengeId: ResourceId; operationId: ResourceId | null; maskedEmail: string; serverTime: IsoDateTime; expiresAt: IsoDateTime; resendAt: IsoDateTime }
export interface AccountSecuritySummary { authMethod: AuthMethod; authVersion: number; email: string | null; emailVerified: boolean; emailVerifiedAt: IsoDateTime | null; totpAvailable: boolean; serverTime: IsoDateTime; emailProviders: EmailProviderType[] }
export interface BindEmailRequest { currentPassword: string; totp: string; email: string }
export interface BindEmailConfirmRequest { currentPassword: string; totp: string; operationId: ResourceId; challengeId: ResourceId; code: string }
export interface PasswordCodeRequest { currentPassword: string }
export interface ChangePasswordRequest { currentPassword: string; newPassword: string; confirmPassword: string; operationId: ResourceId; challengeId: ResourceId; code: string }
/** 旧邮箱授权从创建起即绑定目标；变更目标必须取消并重新验证。 */
export interface ChangeEmailRequest { currentPassword: string; newEmail: string }
export interface VerifyOldEmailRequest { currentPassword: string; operationId: ResourceId; challengeId: ResourceId; code: string }
export interface AccountOperationRequest { operationId: ResourceId }
export interface EmailChangeAuthorization { operationId: ResourceId; targetEmailMasked: string; expiresAt: IsoDateTime; serverTime: IsoDateTime }
export interface ChangeEmailConfirmRequest { currentPassword: string; operationId: ResourceId; challengeId: ResourceId; code: string }
export type NotificationStatus = "not_required" | "pending" | "sent" | "failed";
export interface AccountMutationResult { success: true; reloginRequired: true; notificationStatus: NotificationStatus }
export type LoginResponse = ApiResponse<AuthSession>;
export type MeResponse = ApiResponse<AuthSession>;
export type MutationResponse = ApiResponse<{ success: true }>;
export type LogoutResponse = MutationResponse;
export type RevokeSessionResponse = MutationResponse;
export type LoginSessionsResponse = ApiResponse<LoginSession[]>;
export interface SessionParams { sessionId: ResourceId }
export interface CategoryParams { categoryId: ResourceId }
export interface VideoParams { videoId: ResourceId }
export interface UploadParams { uploadId: ResourceId }
export interface UploadPartParams extends UploadParams { partNumber: number }
export interface CreateCategoryRequest { name: string; sortOrder?: number }
export interface UpdateCategoryRequest { name?: string; sortOrder?: number; archived?: boolean }
export interface OrganizationListQuery { includeArchived?: boolean }
export interface CreateGroupRequest { name: string; description?: string; sortOrder?: number }
export interface UpdateGroupRequest { name?: string; description?: string; sortOrder?: number; archived?: boolean }
export interface CreateTagRequest { name: string }
export interface UpdateTagRequest { name?: string; archived?: boolean }
export type GroupsResponse = ApiResponse<LibraryGroup[]>;
export type GroupResponse = ApiResponse<LibraryGroup>;
export type TagsResponse = ApiResponse<Tag[]>;
export type TagResponse = ApiResponse<Tag>;
export type CategoriesResponse = ApiResponse<Category[]>;
export type CategoryResponse = ApiResponse<Category>;
/** HTTP groupIds/tagIds 使用逗号分隔；重复、空项和超过 20 项拒绝，维度间 AND、多选全命中。 */
export interface VideoListQuery extends PaginationQuery { categoryId?: ResourceId; groupIds?: string; tagIds?: string; q?: string; tags?: string }
export interface UpdateVideoRequest { title?: string; categoryId?: ResourceId; groupIds?: ResourceId[]; tagIds?: ResourceId[]; tags?: string[] }
export interface RegisterPublicVideoRequest { publicUrl: string; title: string; categoryId: ResourceId; tags: string[] }
export type VideosResponse = ApiResponse<Page<VideoSummary>>;
export type VideoResponse = ApiResponse<VideoDetail>;
export interface SaveProgressRequest { positionSeconds: number }
export type ProgressResponse = ApiResponse<WatchProgress>;
export type UsageResponse = ApiResponse<ApplicationUsage>;
export interface ApplicationLimits { maxUploadBytes: Bytes; partSizeBytes: Bytes; maxUploadConcurrency: number; maxPlaybackSessions: number; maxAuthorizationsPerMinute: number; uploadObjectPrefix?: string }
export type LimitsResponse = ApiResponse<ApplicationLimits>;
export type PlaybackSessionResponse = ApiResponse<PlaybackSession>;
export type PlaybackSourceResponse = ApiResponse<PlaybackSource>;
export type DownloadAuthorizationResponse = ApiResponse<DownloadAuthorization>;
/** 心跳只续应用会话；不返回或更新源URL，续签必须调用source路由。 */
export type PlaybackHeartbeat = Pick<PlaybackSession, "id" | "videoId" | "mode" | "expiresAt">;
export type PlaybackHeartbeatResponse = ApiResponse<PlaybackHeartbeat>;
export type PlaybackCloseResponse = MutationResponse;
export interface StreamQuery { playbackSessionId: ResourceId }
export interface CreateUploadRequest extends OrganizationSelection { fileName: string; sizeBytes: Bytes; title: string; tags?: string[]; clientRequestId?: string }
export interface CsrfHeaders { "x-csrf-token": string }
export interface UploadPartHeaders extends CsrfHeaders {
  "content-type": "application/octet-stream";
  "x-part-checksum": PartChecksum;
}
export type UploadResponse = ApiResponse<UploadTask>;
export type UploadPartResponse = ApiResponse<UploadedPart>;
export type CompleteUploadResponse = ApiResponse<{ upload: UploadTask; video: VideoDetail }>;
/** 空串选择服务端配置的授权根范围；非空只能选择授权根下的目录前缀。 */
export interface ImportPreviewRequest { prefix: string; cursor?: string }
export interface ImportCommitRequest extends OrganizationSelection { previewId: ResourceId; itemIds: ResourceId[]; existingVideoId?: ResourceId }
export type ImportPreviewResponse = ApiResponse<ImportPreview>;
export type ImportCommitResponse = ApiResponse<{ videos: VideoDetail[] }>;
export const CSRF_HEADER = "x-csrf-token" as const;
