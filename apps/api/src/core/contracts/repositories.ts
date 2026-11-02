import type { FastifyRequest } from "fastify";
import type {
  ApplicationUsage, CreateUploadRequest, CurrentUser, IsoDateTime, PlaybackSession,
  TransferPolicy, UploadedPart, UploadStatus, UploadTask, VideoDetail, VideoStatus,
  OrganizationSelection, PlaybackMode, Page, UploadListQuery, SaveVideoDurationRequest, DeleteVideoResult
} from "@online-video/shared";

export interface AuthPrincipal { user: CurrentUser; loginSessionId: string; guest?: import("@online-video/shared").GuestAccess }
export interface AuthGuard {
  /** 每次请求验证登录会话过期/撤销；mutation 同时校验 x-csrf-token 和可信来源。 */
  requireUser(request: FastifyRequest, options: { mutation: boolean }): Promise<AuthPrincipal>;
}
/** legacy 仅保留旧库/显式 Mock 兼容，真实 OSS 不得推断其 Bucket。 */
export type StorageObjectRef = { kind?: "legacy"; key: string } | RegisteredStorageObjectRef;
export interface RegisteredStorageObjectRef {
  kind: "registered"; id: string; provider: "oss" | "mock"; bucket: string; region: string;
  key: string; versionId: string | null; verificationStatus: "pending" | "verified" | "unavailable";
}
export interface OrganizationRepository {
  assertOwned(ownerId: string, selection: OrganizationSelection): Promise<void>;
  normalizeSelection?(ownerId: string, input: { categoryId: string; tags?: string[] }): Promise<OrganizationSelection & { tags: string[] }>;
}
export interface StorageObjectRepository {
  prepareCover?(input: { ownerId: string; videoId: string; checksum: string; sizeBytes: number; contentType: "image/jpeg"; object: Omit<RegisteredStorageObjectRef, "kind" | "id" | "verificationStatus"> }): Promise<{ object: RegisteredStorageObjectRef; operationId: string; state: string }>;
  prepare(input: { ownerId: string; object: Omit<RegisteredStorageObjectRef, "kind" | "id" | "verificationStatus">;
    operation: "upload" | "import" }): Promise<{ object: RegisteredStorageObjectRef; operationId: string }>;
  verify(input: { ownerId: string; object: RegisteredStorageObjectRef; metadata: import("./storage.js").StorageMetadata }): Promise<RegisteredStorageObjectRef>;
  recordOperation(input: { ownerId: string; operationId: string; state: "multipart_started" | "object_completed" | "registered" | "failed";
    storageUploadId?: string; uploadId?: string; videoId?: string; errorCode?: string }): Promise<void>;
}
export interface VideoRecord {
  ownerId: string;
  video: VideoDetail;
  originalObject: StorageObjectRef;
  playbackObject: StorageObjectRef;
  thumbnailObject: StorageObjectRef | null;
}
export interface VideoRepository {
  saveDurationIfMissing?(ownerId: string, videoId: string, input: SaveVideoDurationRequest): Promise<VideoRecord>;
  deleteOwnedRecord?(ownerId: string, videoId: string): Promise<DeleteVideoResult>;
  saveCover?(input: { ownerId: string; videoId: string; thumbnailObject: RegisteredStorageObjectRef; operationId?: string }): Promise<VideoRecord>;
  /** 在创建存储对象或导入前校验分类归属；无权/不存在返回 NOT_FOUND。 */
  assertCategoryOwned(ownerId: string, categoryId: string): Promise<void>;
  assertOrganizationOwned?(ownerId: string, selection: OrganizationSelection): Promise<void>;
  /** 所有读取/写入均绑定 ownerId；其他账户的资源必须返回 null 或 NOT_FOUND。 */
  findOwned(ownerId: string, videoId: string): Promise<VideoRecord | null>;
  /** 完整registered对象/资产身份原子幂等；legacy仅按owner+key兼容，已有记录不覆盖元数据。
   * 新记录再次校验分类归属；唯一性必须跨进程/重启成立，不能只用内存去重。
   */
  register(input: VideoRecord): Promise<VideoRecord>;
  /** 单个已验证预览对象的显式legacy回填；旧key精确匹配，保留id/标题/组织/进度。 */
  bindLegacy?(input: { ownerId: string; videoId: string; record: VideoRecord }): Promise<VideoRecord>;
  updateMedia(ownerId: string, videoId: string, patch: {
    status: VideoStatus; durationSeconds: number | null; codec: string | null;
    width: number | null; height: number | null; playable: boolean;
    playbackObject: StorageObjectRef; thumbnailObject: StorageObjectRef | null;
  }): Promise<VideoRecord>;
}
export interface StoredPart extends UploadedPart { etag: string }
export interface UploadRecord {
  operationId?: string;
  ownerId: string;
  task: UploadTask;
  title: string;
  categoryId: string;
  object: StorageObjectRef;
  storageUploadId: string;
  parts: StoredPart[];
}
export interface UploadRepository {
  listOwned?(ownerId: string, query: UploadListQuery): Promise<Page<UploadTask>>;
  findByClientRequestId?(ownerId: string, clientRequestId: string, request?: CreateUploadRequest): Promise<UploadRecord | null>;
  /** 原子完成视频/资产/组织/任务及操作登记；重复调用返回同视频。 */
  finishRegistration?(input: { ownerId: string; uploadId: string; video: VideoRecord; operationId?: string }): Promise<{ upload: UploadRecord; video: VideoRecord }>;
  create(input: { ownerId: string; request: CreateUploadRequest; object: StorageObjectRef;
    storageUploadId: string; partSizeBytes: number; operationId?: string }): Promise<UploadRecord>;
  /** 创建时空 storageUploadId 表示持久化意图已记录；初始化 OSS 后 CAS 绑定并可幂等恢复。 */
  attachMultipart?(input: { ownerId: string; uploadId: string; storageUploadId: string; operationId?: string }): Promise<UploadRecord>;
  findOwned(ownerId: string, uploadId: string): Promise<UploadRecord | null>;
  /** 原子写入；相同 partNumber/size/checksum 幂等，冲突返回 FILE_MISMATCH。 */
  savePart(ownerId: string, uploadId: string, part: StoredPart): Promise<UploadRecord>;
  /** CAS：只有 expected 状态允许转换；videoId 仅服务端登记后设置。
   * 单 API 实例可在任务锁内用 finalizing -> finalizing 校验状态并恢复崩溃后的完成任务；
   * 同状态 CAS 不表示获得跨进程互斥，多实例装配需额外的持久化任务租约。
   */
  transition(ownerId: string, uploadId: string, expected: UploadStatus,
    next: UploadStatus, videoId?: string): Promise<UploadRecord>;
}
export interface PlaybackRecord {
  ownerId: string;
  loginSessionId: string;
  session: PlaybackSession;
  lastSeenAt: IsoDateTime;
  closedAt: IsoDateTime | null;
}
export interface PlaybackRepository {
  /** 必须原子检查过期与并发再创建；多个 Range 请求复用一个会话，不占新名额。 */
  create(input: { principal: AuthPrincipal; videoId: string; expiresAt: IsoDateTime;
    maxActiveSessions: number; now: IsoDateTime; mode?: PlaybackMode }): Promise<PlaybackRecord>;
  /** URL 仅保存在当前响应，SQL只存模式/到期与无秘密审计。原子重查登录和关闭状态。 */
  authorize?(input: { principal: AuthPrincipal; sessionId?: string; videoId: string; purpose: "playback" | "renewal" | "download";
    sourceExpiresAt: IsoDateTime; now: IsoDateTime; maxAuthorizationsPerMinute: number }): Promise<void>;
  /** 同时验证 ownerId/loginSessionId/videoId/有效期/活动状态。 */
  findActive(input: { principal: AuthPrincipal; sessionId: string; videoId?: string;
    now: IsoDateTime }): Promise<PlaybackRecord | null>;
  heartbeat(principal: AuthPrincipal, sessionId: string, now: IsoDateTime): Promise<PlaybackRecord>;
  close(principal: AuthPrincipal, sessionId: string, now: IsoDateTime): Promise<void>;
}
export interface UsagePeriod { start: IsoDateTime; end: IsoDateTime; timezone: string }
export interface TransferReservation { id: string; grantedBytes: number }
export interface UsageRepository {
  read(ownerId: string, period: UsagePeriod, policy: TransferPolicy, mode?: PlaybackMode): Promise<ApplicationUsage>;
  /** 原子预留下一小块额度。未配置返回 SERVICE_NOT_CONFIGURED，超限返回 TRANSFER_LIMIT_EXCEEDED。
   * 在途预留也占额度；grantedBytes <= requestedBytes，禁止先发后检查。
   */
  reserve(input: { ownerId: string; playbackSessionId: string; period: UsagePeriod;
    requestedBytes: number; policy: TransferPolicy }): Promise<TransferReservation>;
  /** 幂等提交实际发出字节并释放未用预留；断开也结算，不直接清零实际用量。 */
  settle(input: { ownerId: string; reservationId: string; transferredBytes: number }): Promise<void>;
}
