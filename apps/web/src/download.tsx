import { useState } from "react";
import type { DownloadAuthorization } from "@online-video/shared";
import { api } from "./api";
import { validateDownload } from "./media";
import { ErrorNotice } from "./ui";

export function OriginalDownload({ videoId }: { videoId: string }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(); const [message, setMessage] = useState("");
  return <div><button className="secondary" disabled={busy} onClick={async () => {
    setBusy(true); setError(undefined); setMessage("");
    try {
      const authorization = validateDownload(await api.request<DownloadAuthorization>(`/api/videos/${encodeURIComponent(videoId)}/download-authorizations`, { method: "POST" }), videoId);
      const anchor = document.createElement("a"); anchor.href = authorization.sourceUrl; anchor.download = authorization.fileName; anchor.target = "_blank"; anchor.rel = "noopener noreferrer"; anchor.referrerPolicy = "no-referrer";
      document.body.append(anchor); anchor.click(); anchor.remove();
      setMessage(`已授权原片“${authorization.fileName}”。浏览器按存储服务的附件响应处理；若直接打开，请使用浏览器保存。`);
    } catch (err) { setError(err); } finally { setBusy(false); }
  }}>{busy ? "正在获取原片授权…" : "下载原片"}</button>{message && <p className="muted" role="status">{message}</p>}{error !== undefined && <ErrorNotice error={error} />}</div>;
}
