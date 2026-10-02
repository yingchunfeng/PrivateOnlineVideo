/** 输出时间统一为 UTC ISO 8601，例如 2026-10-01T10:00:00.000Z。 */
export type IsoDateTime = string;
/** Bytes 是非负安全整数，1 byte = 1 字节；秒数允许非负小数。 */
export type Bytes = number;
export type ResourceId = string;
export type ApiPath = `/api/${string}`;
export const PLAYBACK_MODE = "proxy" as const;
export type PlaybackMode = typeof PLAYBACK_MODE;
export const VIDEO_STATUSES = ["processing", "ready", "unsupported", "failed"] as const;
export type VideoStatus = typeof VIDEO_STATUSES[number];
export const UPLOAD_STATUSES = ["uploading", "finalizing", "completed", "failed"] as const;
export type UploadStatus = typeof UPLOAD_STATUSES[number];
export interface ApiResponse<T> { data: T }
export interface Page<T> { items: T[]; page: number; pageSize: number; total: number }
export interface PaginationQuery { page?: number; pageSize?: number }
export interface CurrentUser { id: ResourceId; displayName: string; totpEnabled: boolean }
export interface Category { id: ResourceId; name: string; sortOrder: number }
export interface VideoSummary {
  id: ResourceId;
  title: string;
  categoryId: ResourceId;
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
export interface PlaybackSession {
  id: ResourceId;
  videoId: ResourceId;
  mode: PlaybackMode;
  sourceUrl: ApiPath;
  expiresAt: IsoDateTime;
}
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
}
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
export type ApplicationUsage = UsageBase & (
  | { limitMode: "limited"; limitBytes: Bytes }
  | { limitMode: "unconfigured" | "unlimited"; limitBytes: null }
);
export interface LoginSession {
  id: ResourceId;
  createdAt: IsoDateTime;
  lastSeenAt: IsoDateTime;
  expiresAt: IsoDateTime;
  isCurrent: boolean;
}
export interface AuthSession { user: CurrentUser; csrfToken: string }
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
export interface ImportPreview { id: ResourceId; items: ImportPreviewItem[]; expiresAt: IsoDateTime }

export interface HealthData { status: "ok" }
export type HealthResponse = ApiResponse<HealthData>;
export interface LoginRequest { password: string; totp: string }
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
export interface UpdateCategoryRequest { name?: string; sortOrder?: number }
export type CategoriesResponse = ApiResponse<Category[]>;
export type CategoryResponse = ApiResponse<Category>;
export interface VideoListQuery extends PaginationQuery { categoryId?: ResourceId; q?: string }
export interface UpdateVideoRequest { title?: string; categoryId?: ResourceId }
export type VideosResponse = ApiResponse<Page<VideoSummary>>;
export type VideoResponse = ApiResponse<VideoDetail>;
export interface SaveProgressRequest { positionSeconds: number }
export type ProgressResponse = ApiResponse<WatchProgress>;
export type UsageResponse = ApiResponse<ApplicationUsage>;
export type PlaybackSessionResponse = ApiResponse<PlaybackSession>;
export type PlaybackHeartbeatResponse = PlaybackSessionResponse;
export type PlaybackCloseResponse = MutationResponse;
export interface StreamQuery { playbackSessionId: ResourceId }
export interface CreateUploadRequest { fileName: string; sizeBytes: Bytes; title: string; categoryId: ResourceId }
export interface CsrfHeaders { "x-csrf-token": string }
export interface UploadPartHeaders extends CsrfHeaders {
  "content-type": "application/octet-stream";
  "x-part-checksum": PartChecksum;
}
export type UploadResponse = ApiResponse<UploadTask>;
export type UploadPartResponse = ApiResponse<UploadedPart>;
export type CompleteUploadResponse = ApiResponse<{ upload: UploadTask; video: VideoDetail }>;
/** 空串选择服务端配置的授权根范围；非空只能选择授权根下的目录前缀。 */
export interface ImportPreviewRequest { prefix: string }
export interface ImportCommitRequest { previewId: ResourceId; itemIds: ResourceId[]; categoryId: ResourceId }
export type ImportPreviewResponse = ApiResponse<ImportPreview>;
export type ImportCommitResponse = ApiResponse<{ videos: VideoDetail[] }>;
export const CSRF_HEADER = "x-csrf-token" as const;
