import type { UploadTask, VideoDetail } from "@online-video/shared";

/** 只记录本机执行器新收到的登记成功，不从历史任务推导动画。 */
export class TaskCompletionEffects {
  private events = new Map<string, { at: number; consumed: boolean }>();
  constructor(private now: () => number = Date.now) {}

  confirmedAt(taskId: string) { return this.events.get(taskId)?.at; }

  confirm(previousStatus: UploadTask["status"], upload: UploadTask, video: Pick<VideoDetail, "id">) {
    if (previousStatus === "completed" || upload.status !== "completed" || !upload.videoId || upload.videoId !== video.id || this.events.has(upload.id)) return false;
    this.events.set(upload.id, { at: this.now(), consumed: false });
    return true;
  }

  consume(taskId: string) {
    const event = this.events.get(taskId);
    if (!event || event.consumed) return false;
    event.consumed = true;
    const elapsed = this.now() - event.at;
    return elapsed >= 0 && elapsed <= 1500;
  }
}
