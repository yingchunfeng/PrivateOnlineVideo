import { useRef, useState } from "react";
import { validVideoExtension } from "./upload-queue";
import { Icon } from "./ui";
import "./upload-sources.css";

const VIDEO_ACCEPT = "video/*,.mp4,.mov,.webm,.mkv,.m4v";

export function UploadSources({ count, disabled, onFiles }: { count: number; disabled: boolean; onFiles: (files: File[]) => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [folderSummary, setFolderSummary] = useState("");
  const addFiles = (files: File[]) => { if (!disabled && files.length) onFiles(files); };
  const addFolder = (files: File[]) => {
    if (disabled || !files.length) return;
    const videos = files.filter(file => validVideoExtension(file.name));
    const skipped = files.length - videos.length;
    setFolderSummary(videos.length
      ? `已加入 ${videos.length} 个视频${skipped ? `，已跳过 ${skipped} 个非视频文件` : ""}。`
      : `所选文件夹没有支持的视频，已跳过 ${skipped} 个非视频文件。`);
    if (videos.length) onFiles(videos);
  };

  return <section className="upload-source-grid" aria-label="选择上传来源">
    <div className="file-source">
      <input ref={fileInput} type="file" aria-label="视频文件" className="visually-hidden-file" accept={VIDEO_ACCEPT} multiple disabled={disabled} onChange={event => {
        const files = Array.from(event.currentTarget.files ?? []);
        event.currentTarget.value = "";
        addFiles(files);
      }} />
      <button type="button" className={`radar-dropzone upload-source-trigger ${count ? "has-file" : ""} ${dragging && !disabled ? "dragging" : ""}`} aria-label="选择视频文件" disabled={disabled} onClick={() => fileInput.current?.click()} onDragOver={event => {
        event.preventDefault();
        event.dataTransfer.dropEffect = disabled ? "none" : "copy";
        if (!disabled) setDragging(true);
      }} onDragLeave={event => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false);
      }} onDrop={event => {
        event.preventDefault();
        setDragging(false);
        addFiles(Array.from(event.dataTransfer.files));
      }}>
        <span className="radar-scanner-circle" aria-hidden="true"><span className="radar-pulse-ring" /><span className="radar-pulse-ring delay" /><span className="upload-orbit-satellite" /><span className="radar-icon-center"><Icon name="cloud-upload" /></span></span>
        <span className="radar-text-group"><strong className="upload-source-title">拖拽视频文件到这里</strong><span className="radar-subtext">或点击浏览文件 · 可多选</span><span className="radar-spec-note">已选 {count} 个文件</span></span>
      </button>
    </div>
    <div className="folder-source">
      <input ref={folderInput} type="file" aria-label="视频文件夹" className="visually-hidden-file" {...{ webkitdirectory: "", directory: "" }} multiple disabled={disabled} onChange={event => {
        const files = Array.from(event.currentTarget.files ?? []);
        event.currentTarget.value = "";
        addFolder(files);
      }} />
      <button type="button" className="radar-dropzone upload-source-trigger" aria-label="选择文件夹" disabled={disabled} onClick={() => folderInput.current?.click()}>
        <span className="radar-scanner-circle" aria-hidden="true"><span className="radar-pulse-ring" /><span className="radar-pulse-ring delay" /><span className="upload-orbit-satellite" /><span className="radar-icon-center"><Icon name="folder" /></span></span>
        <span className="radar-text-group"><strong className="upload-source-title">选择文件夹</strong><span className="radar-subtext">包含子目录的视频自动加入列表</span><span className="radar-spec-note">仅加入视频，不会自动上传</span><span className="upload-source-note" role="status" aria-live="polite">{folderSummary || "支持 MP4 / MOV / WEBM / MKV / M4V"}</span></span>
      </button>
    </div>
  </section>;
}
