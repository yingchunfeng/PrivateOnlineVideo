import { useState } from "react";
import { Link } from "react-router-dom";
import type { LibraryConfig, RegisterPublicVideoRequest, VideoDetail } from "@online-video/shared";
import { api } from "./api";
import { LibraryFields } from "./library";
import { defaultLibraryCategory } from "./library-data";
import { PublicAddress } from "./public-address";
import { ErrorNotice } from "./ui";
import { useFeedback } from "./feedback";

export function PublicRegisterPanel({ library, onImported }: { library: LibraryConfig; onImported: () => void }) {
  const [publicUrl, setPublicUrl] = useState(""); const [title, setTitle] = useState(""); const [category, setCategory] = useState(""); const [tags, setTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false); const [video, setVideo] = useState<VideoDetail>(); const { toast, toastError } = useFeedback();
  return <section className="panel stack import-panel"><h2>登记已有公开视频</h2><p className="muted">登记媒体域名 {library.mediaBaseUrl}、{library.objectPrefix} 范围内的公开地址，原视频保持原位置。</p><form className="stack" onSubmit={async event => {
    event.preventDefault(); if (busy) return; setBusy(true); setVideo(undefined);
    try { const registered = await api.request<VideoDetail>("/api/videos/register-public", { method: "POST", body: { publicUrl: publicUrl.trim(), title: title.trim(), categoryId: category || defaultLibraryCategory(library.categories), tags } satisfies RegisterPublicVideoRequest }); setVideo(registered); toast("公开视频已登记"); onImported(); }
    catch (err) { toastError(err); } finally { setBusy(false); }
  }}><label>公开视频地址<input type="url" value={publicUrl} onChange={event => setPublicUrl(event.target.value)} placeholder={`${library.mediaBaseUrl}/${library.objectPrefix}...`} required disabled={busy} /></label><label>视频标题<input value={title} onChange={event => setTitle(event.target.value)} maxLength={200} required disabled={busy} /></label><LibraryFields library={library} category={category} tags={tags} onCategory={setCategory} onTags={setTags} disabled={busy} /><button type="submit" disabled={busy || !title.trim() || !publicUrl.trim() || !(category || defaultLibraryCategory(library.categories))}>{busy ? "正在登记…" : "登记公开视频"}</button></form>{video && <div className="stack"><Link className="button" to={`/videos/${encodeURIComponent(video.id)}`}>播放视频</Link><PublicAddress publicUrl={video.publicUrl} library={library} /></div>}</section>;
}
