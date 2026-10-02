import type { FastifyRequest } from "fastify";
import type {
  ApplicationUsage, CreateUploadRequest, CurrentUser, IsoDateTime, PlaybackSession,
  TransferPolicy, UploadedPart, UploadStatus, UploadTask, VideoDetail, VideoStatus
} from "@online-video/shared";

export interface AuthPrincipal { user: CurrentUser; loginSessionId: string }
export interface AuthGuard {
  /** 每次请求验证登录会话过期/撤销；mutation 同时校验 x-csrf-token 和可信来源。 */
  requireUser(request: FastifyRequest, options: { mutation: boolean }): Promise<AuthPrincipal>;
}
export interface StorageObjectRef { key: string }
export interface VideoRecord {
  ownerId: string;
  video: VideoDetail;
  originalObject: StorageObjectRef;
  playbackObject: StorageObjectRef;
  thumbnailObject: StorageObjectRef | null;
}
export interface VideoRepository {
  /** 在创建存储对象或导入前校验分类归属；无权/不存在返回 NOT_FOUND。 */
  assertCategoryOwned(ownerId: string, categoryId: string): Promise<void>;
  /** 所有读取/写入均绑定 ownerId；其他账户的资源必须返回 null 或 NOT_FOUND。 */
  findOwned(ownerId: string, videoId: string): Promise<VideoRecord | null>;
  /** 按 ownerId + originalObject.key 原子幂等，已有对象返回原记录且不覆盖元数据。
   * 新记录再次校验分类归属；唯一性必须跨进程/重启成立，不能只用内存去重。
   */
  register(input: VideoRecord): Promise<VideoRecord>;
  updateMedia(ownerId: string, videoId: string, patch: {
    status: VideoStatus; durationSeconds: number | null; codec: string | null;
    width: number | null; height: number | null; playable: boolean;
    playbackObject: StorageObjectRef; thumbnailObject: StorageObjectRef | null;
  }): Promise<VideoRecord>;
}
export interface StoredPart extends UploadedPart { etag: string }
export interface UploadRecord {
  ownerId: string;
  task: UploadTask;
  title: string;
  categoryId: string;
  object: StorageObjectRef;
  storageUploadId: string;
  parts: StoredPart[];
}
export interface UploadRepository {
  create(input: { ownerId: string; request: CreateUploadRequest; object: StorageObjectRef;
    storageUploadId: string; partSizeBytes: number }): Promise<UploadRecord>;
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
    maxActiveSessions: number; now: IsoDateTime }): Promise<PlaybackRecord>;
  /** 同时验证 ownerId/loginSessionId/videoId/有效期/活动状态。 */
  findActive(input: { principal: AuthPrincipal; sessionId: string; videoId: string;
    now: IsoDateTime }): Promise<PlaybackRecord | null>;
  heartbeat(principal: AuthPrincipal, sessionId: string, now: IsoDateTime): Promise<PlaybackRecord>;
  close(principal: AuthPrincipal, sessionId: string, now: IsoDateTime): Promise<void>;
}
export interface UsagePeriod { start: IsoDateTime; end: IsoDateTime; timezone: string }
export interface TransferReservation { id: string; grantedBytes: number }
export interface UsageRepository {
  read(ownerId: string, period: UsagePeriod, policy: TransferPolicy): Promise<ApplicationUsage>;
  /** 原子预留下一小块额度。未配置返回 SERVICE_NOT_CONFIGURED，超限返回 TRANSFER_LIMIT_EXCEEDED。
   * 在途预留也占额度；grantedBytes <= requestedBytes，禁止先发后检查。
   */
  reserve(input: { ownerId: string; playbackSessionId: string; period: UsagePeriod;
    requestedBytes: number; policy: TransferPolicy }): Promise<TransferReservation>;
  /** 幂等提交实际发出字节并释放未用预留；断开也结算，不直接清零实际用量。 */
  settle(input: { ownerId: string; reservationId: string; transferredBytes: number }): Promise<void>;
}
