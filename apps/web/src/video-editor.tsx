import { useEffect, useRef, useState } from "react";
import type { DeleteVideoResult, LibraryConfig, UpdateVideoRequest, VideoDetail } from "@online-video/shared";
import { api } from "./api";
import { ErrorNotice, Loading, Modal, useLoad } from "./ui";
import { libraryTags, publicMediaUrl } from "./library-data";
import { TagChoice } from "./library";
import { sameSelection } from "./organization";
import { useFeedback } from "./feedback";
import { useUploadQueue } from "./upload-context";
import { useAuth } from "./auth";
import "./pages/video-editor.css";

const COVER_MAX_BYTES = 2 * 1024 * 1024;
const COVER_MAX_EDGE = 960;

/** 服务端只接收长边 960 内、2 MiB 的 JPEG；其它格式或超限时用 canvas 重编码，符合"浏览器重编码 JPEG"的原设计。 */
async function normalizeCoverFile(file: File): Promise<File> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error("这张图片无法读取，请换一张 JPG 或 PNG 图片")); img.src = url; });
    const longest = Math.max(img.naturalWidth, img.naturalHeight);
    if (!longest) throw new Error("图片尺寸无效，请换一张图片");
    if (file.type === "image/jpeg" && file.size <= COVER_MAX_BYTES && longest <= COVER_MAX_EDGE) return file;
    const scale = Math.min(1, COVER_MAX_EDGE / longest);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前浏览器不支持图片压缩，请使用长边不超过 960 像素的 JPEG 图片");
    // PNG 等带透明通道的图片转 JPEG 前先铺白底，避免透明区域变成黑块。
    context.fillStyle = "#ffffff"; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob || blob.size <= 0) throw new Error("封面转换失败，请换一张图片");
    if (blob.size > COVER_MAX_BYTES) throw new Error("封面转换后仍超过 2 MiB，请换一张内容更简单的图片");
    return new File([blob], `${file.name.replace(/\.[^.]+$/, "") || "cover"}.jpg`, { type: "image/jpeg" });
  } finally { URL.revokeObjectURL(url); }
}

export function VideoEditorDialog({ videoId, library, onClose, onSaved, onDeleted }: {
  videoId: string; library: LibraryConfig; onClose: () => void; onSaved: (video: VideoDetail) => void; onDeleted: () => void;
}) {
  const detail = useLoad(() => api.request<VideoDetail>(`/api/videos/${encodeURIComponent(videoId)}`), [videoId]);
  const [deleted, setDeleted] = useState<DeleteVideoResult>();
  if (deleted) return <DeletedVideoResult result={deleted} onClose={onClose} />;
  if (detail.busy || !detail.data) return <Modal title="编辑视频信息" onClose={onClose}>{detail.error ? <ErrorNotice error={detail.error} retry={detail.reload} /> : <Loading />}</Modal>;
  return <VideoEditorForm video={detail.data} library={library} onClose={onClose} onSaved={onSaved} onDeleted={result => { setDeleted(result); onDeleted(); }} />;
}

function VideoEditorForm({ video, library, onClose, onSaved, onDeleted }: {
  video: VideoDetail; library: LibraryConfig; onClose: () => void; onSaved: (video: VideoDetail) => void; onDeleted: (result: DeleteVideoResult) => void;
}) {
  const auth = useAuth(); const canEdit = auth.can("video_edit"); const canDelete = auth.can("video_delete");
  const [title, setTitle] = useState(video.title); const [category, setCategory] = useState(video.categoryId); const [tags, setTags] = useState(video.tags ?? []);
  const [cover, setCover] = useState<File>(); const [coverPreview, setCoverPreview] = useState<string>();
  const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(); const [notice, setNotice] = useState("");
  const saving = useRef(false); const { confirm } = useFeedback();
  const { queue } = useUploadQueue();
  useEffect(() => { if (!cover) { setCoverPreview(undefined); return; } const url = URL.createObjectURL(cover); setCoverPreview(url); return () => URL.revokeObjectURL(url); }, [cover]);
  const selected = library.categories.find(item => item.id === category);
  const availableTags = selected?.enabled !== false ? libraryTags(library.categories, category) : [];
  let existingCover: string | undefined;
  try { if (video.coverUrl) existingCover = publicMediaUrl(video.coverUrl, library); } catch { /* 无效旧封面不影响编辑或替换。 */ }
  return <Modal title="编辑视频信息" description="修改标题、分类、标签或封面。替换封面不会删除旧 OSS 对象。" busy={busy} className="video-edit-dialog" onClose={onClose} footer={<><button className="secondary" type="button" disabled={busy} onClick={onClose}>取消</button>{canEdit && <button form="video-editor" type="submit" disabled={busy || !title.trim() || !category}>{busy ? "正在保存…" : "保存视频信息"}</button>}</>}>
    <form id="video-editor" className="stack video-editor" aria-busy={busy} onSubmit={async event => {
      event.preventDefault(); if (!canEdit || saving.current || !title.trim()) return; saving.current = true; setBusy(true); setError(undefined); setNotice("");
      try {
        let saved = await api.request<VideoDetail>(`/api/videos/${encodeURIComponent(video.id)}`, { method: "PATCH", body: { title: title.trim(), ...(category !== video.categoryId ? { categoryId: category, tags } : !sameSelection(tags, video.tags ?? []) ? { tags } : {}) } satisfies UpdateVideoRequest });
        if (cover) {
          try { saved = await api.image<VideoDetail>(`/api/videos/${encodeURIComponent(video.id)}/cover`, cover); }
          catch (err) { setNotice("标题、分类与标签已保存；封面未保存，当前选择已保留，可再次保存重试。"); throw err; }
        }
        onSaved(saved);
      } catch (err) { setError(err); } finally { saving.current = false; setBusy(false); }
    }}>
      <fieldset disabled={!canEdit || busy}>
      <div className="video-editor-fields"><label>视频标题<input value={title} onChange={event => setTitle(event.target.value)} maxLength={200} required disabled={busy} autoFocus /></label><label>视频分类<select aria-label="视频分类" value={category} required disabled={busy} onChange={event => { const next = event.target.value; const valid = libraryTags(library.categories, next); setCategory(next); setTags(current => current.filter(tag => valid.includes(tag))); }}>
        {!library.categories.some(item => item.id === video.categoryId) && <option value={video.categoryId}>当前分类（历史记录）</option>}
        {library.categories.map(item => <option key={item.id} value={item.id} disabled={item.enabled === false}>{item.name}{item.enabled === false ? "（已停用）" : ""}</option>)}
      </select></label></div>
      <TagChoice items={availableTags} selected={tags} onChange={setTags} disabled={busy} />
      <small>切换分类时仅保留该分类可用的标签；历史标签可保留或取消。</small>
      <div className="video-editor-cover">{(coverPreview || existingCover) && <img src={coverPreview ?? existingCover} alt="待保存视频封面" />}<div className="stack"><label>替换封面（JPG/PNG 等图片，自动转为 960px 内 JPEG；最大 2 MiB）<input type="file" accept="image/*" disabled={busy} onChange={event => {
        const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
        if (!file.type.startsWith("image/") || file.size <= 0) { setError(new Error("请选择 JPG、PNG 等图片文件作为封面，原封面已保留")); return; }
        normalizeCoverFile(file).then(normalized => { setCover(normalized); setError(undefined); }).catch(err => setError(err));
      }} /></label>{cover && <><small>{cover.name}，保存后才替换数据库封面引用。</small><button className="secondary" type="button" disabled={busy} onClick={() => setCover(undefined)}>取消本次封面替换</button></>}</div></div>
      </fieldset>
      {notice && <div className="notice" role="status">{notice}</div>}{error !== undefined && <ErrorNotice error={error} />}
      <div hidden={!canDelete}>
      <section className="video-editor-danger"><strong>仅删除数据库记录</strong><p>清除本视频及必要关联记录，不会删除 OSS 内容。成功后可复制真实对象路径，自行到 OSS 处理。上传、封面保存或站内播放尚未结束时需要先结束相关操作。</p><button className="secondary confirm-danger" type="button" disabled={busy} onClick={async () => {
        if (saving.current) return;
        const accepted = await confirm({ title: "仅删除数据库记录", message: `确认删除“${video.title}”的数据库记录及其观看进度、标签/分组和播放授权关联？不会删除 OSS 内容，已完成上传任务保留但解除视频引用。此操作不能撤销，也不会让公共直链失效。`, confirmLabel: "确认仅删除记录", danger: true });
        if (!accepted || saving.current) return;
        saving.current = true; setBusy(true); setError(undefined);
        try { const result = await api.request<DeleteVideoResult>(`/api/videos/${encodeURIComponent(video.id)}`, { method: "DELETE", body: { confirm: true } }); if (result.videoId !== video.id || !Array.isArray(result.objects)) throw new Error("服务端未返回此视频的删除结果，请刷新后核对"); queue.detachVideo(result.videoId); onDeleted(result); }
        catch (err) { setError(err); } finally { saving.current = false; setBusy(false); }
      }}>仅删除数据库记录</button></section>
      </div>
    </form>
  </Modal>;
}

function DeletedVideoResult({ result, onClose }: { result: DeleteVideoResult; onClose: () => void }) {
  const [message, setMessage] = useState("");
  const roles = { original: "视频原文件", playback: "播放文件", thumbnail: "已知封面" };
  const text = [`视频：${result.title}`, "数据库记录已删除；OSS 内容未删除。", ...result.objects.map(object => `${roles[object.role]}\nBucket: ${object.bucket || "无法确定 Bucket"}\nObject Key: ${object.objectKey || "无法确定对象路径"}${object.publicUrl ? `\n原始地址: ${object.publicUrl}` : ""}`)].join("\n\n");
  return <Modal title="记录已删除，OSS 内容保留" description="请保存下方清单；本结果会保留到你主动关闭。" className="video-delete-result" onClose={onClose} footer={<><button className="secondary" onClick={onClose}>关闭</button><button onClick={async () => { try { if (!navigator.clipboard) throw new Error(); await navigator.clipboard.writeText(text); setMessage("对象清单已复制"); } catch { setMessage("复制失败，请选中下方文本手动复制。"); } }}>复制 OSS 路径清单</button></>}>
    <div className="stack"><div className="notice" role="status">仅数据库记录删除成功，没有发送 OSS 删除请求。无法确定的 Bucket/对象位置不会根据 URL 猜测。</div><label>OSS 对象路径清单<textarea aria-label="OSS 对象路径清单" className="video-object-manifest" readOnly value={text} rows={12} onFocus={event => event.currentTarget.select()} /></label>{message && <p role="status">{message}</p>}</div>
  </Modal>;
}
