export const ERROR_DEFINITIONS = {
  VALIDATION_ERROR: { status: 400, message: "请求参数不合法" },
  AUTH_REQUIRED: { status: 401, message: "请先登录" },
  INVALID_CREDENTIALS: { status: 401, message: "密码或动态验证码不正确，或验证码已使用" },
  SESSION_EXPIRED: { status: 401, message: "登录会话已失效" },
  FORBIDDEN: { status: 403, message: "无权访问此资源" },
  CSRF_REJECTED: { status: 403, message: "请求来源校验失败" },
  NOT_FOUND: { status: 404, message: "资源不存在或不可访问" },
  UPLOAD_STATE_CONFLICT: { status: 409, message: "上传任务状态冲突" },
  ORGANIZATION_CONFLICT: { status: 409, message: "组织名称重复、已归档或默认分类受保护" },
  FILE_MISMATCH: { status: 409, message: "文件或分片校验不一致" },
  PAYLOAD_TOO_LARGE: { status: 413, message: "请求内容超过允许大小" },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, message: "请求内容类型不支持" },
  RANGE_NOT_SATISFIABLE: { status: 416, message: "请求范围无效" },
  RATE_LIMITED: { status: 429, message: "请求过于频繁" },
  PLAYBACK_CONCURRENCY_LIMIT: { status: 429, message: "播放会话达到上限" },
  TRANSFER_LIMIT_EXCEEDED: { status: 429, message: "传输流量达到上限" },
  INTERNAL_ERROR: { status: 500, message: "服务暂时无法处理请求" },
  STORAGE_UNAVAILABLE: { status: 503, message: "存储暂不可用" },
  STORAGE_PERMISSION_DENIED: { status: 503, message: "OSS访问或上传权限不足，请检查服务端凭据及新对象公共读权限" },
  UPLOAD_REGISTRATION_FAILED: { status: 503, message: "视频对象已上传，但信息登记失败；请重试完成上传，勿重新上传文件" },
  SERVICE_NOT_CONFIGURED: { status: 503, message: "服务尚未完成安全配置" },
  CONFIG_VERSION_CONFLICT: { status: 409, message: "配置已被其他请求修改，请刷新后重试" },
  CONFIG_READ_ONLY: { status: 503, message: "当前配置不可写" },
  CONFIG_SAVE_FAILED: { status: 503, message: "配置保存失败，未确认成功，请刷新后核对" },
  CONFIG_RECOVERY_REQUIRED: { status: 503, message: "配置一致性恢复失败，已停止配置读写，请检查保存日志" },
  CONFIG_IMPACT_CONFIRMATION_REQUIRED: { status: 409, message: "此修改影响历史视频、任务或共用标签，请确认影响后重试" },
  COVER_REGISTRATION_FAILED: { status: 503, message: "封面对象已保存但关联失败；请重试补封面，无需重传视频" }
} as const;

export type ErrorCode = keyof typeof ERROR_DEFINITIONS;
export interface ErrorResponse {
  error: { code: ErrorCode; message: string; requestId: string };
}
