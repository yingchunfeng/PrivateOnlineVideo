import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { LibraryConfig, RegisterPublicVideoRequest, VideoDetail } from "@online-video/shared";
import { api } from "./api";
import { LibraryFields } from "./library";
import { defaultLibraryCategory } from "./library-data";
import { PublicAddress } from "./public-address";
import { ErrorNotice } from "./ui";
import { useFeedback } from "./feedback";
import { isVideoDuration } from "./media-duration";
import { videoDuration } from "./ui";

export function PublicRegisterPanel({ library, onImported, formId, onStateChange }: { library: LibraryConfig; onImported: () => void; formId?: string; onStateChange?: (state: { busy: boolean; canSubmit: boolean }) => void }) {
  const [publicUrl, setPublicUrl] = useState(""); const [title, setTitle] = useState(""); const [category, setCategory] = useState(""); const [tags, setTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false); const [video, setVideo] = useState<VideoDetail>(); const [error, setError] = useState<unknown>(); const { toast, toastError } = useFeedback();
  const canSubmit = !!title.trim() && !!publicUrl.trim() && !!(category || defaultLibraryCategory(library.categories));
  const result = useRef<HTMLDivElement>(null);
  useEffect(() => { onStateChange?.({ busy, canSubmit }); }, [busy, canSubmit, onStateChange]);
  useEffect(() => { if (video || error !== undefined) result.current?.scrollIntoView({ block: "nearest" }); }, [video, error]);
  return <section className="panel stack import-panel"><h2>登记已有公开视频</h2><p className="muted">登记媒体域名 {library.mediaBaseUrl}、{library.objectPrefix} 范围内的公开地址，原视频保持原位置。</p><form id={formId} className="stack" onSubmit={async event => {
    event.preventDefault(); if (busy || !canSubmit) return; setBusy(true); setVideo(undefined); setError(undefined);
    try { const registered = await api.request<VideoDetail>("/api/videos/register-public", { method: "POST", body: { publicUrl: publicUrl.trim(), title: title.trim(), categoryId: category || defaultLibraryCategory(library.categories), tags } satisfies RegisterPublicVideoRequest }); setVideo(registered); toast("公开视频已登记"); onImported(); }
    catch (err) { setError(err); toastError(err); } finally { setBusy(false); }
  }}><label>公开视频地址<input type="url" value={publicUrl} onChange={event => setPublicUrl(event.target.value)} placeholder={`${library.mediaBaseUrl}/${library.objectPrefix}...`} required disabled={busy} /></label><label>视频标题<input value={title} onChange={event => setTitle(event.target.value)} maxLength={200} required disabled={busy} /></label><LibraryFields library={library} category={category} tags={tags} onCategory={setCategory} onTags={setTags} disabled={busy} />{!formId && <button type="submit" disabled={busy || !canSubmit}>{busy ? "正在登记…" : "登记公开视频"}</button>}</form><div ref={result}>{error !== undefined && <ErrorNotice error={error} />}{video && <div className="stack"><p role="status">登记成功，可播放或复制公共地址。</p><div className="notice">{isVideoDuration(video.durationSeconds) ? `时长已保存：${videoDuration(video.durationSeconds)}` : "时长待采集：打开视频详情后，仅对此视频读取并保存真实时长；失败可在详情页重试，无需重新上传。"}</div><Link className="button" to={`/videos/${encodeURIComponent(video.id)}`}>播放视频</Link><PublicAddress publicUrl={video.publicUrl} library={library} /></div>}</div></section>;
}
