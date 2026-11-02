export interface SiteSettings {
  version: number;
  defaultTheme: "light" | "dark";
  maxUploadBytes: number;
  maxConfigurableUploadBytes: number;
  partSizeBytes: number;
  persistenceAvailable: boolean;
}

export interface UpdateSiteSettingsRequest {
  version: number;
  defaultTheme?: "light" | "dark";
  maxUploadBytes?: number;
}

export interface SaveVideoDurationRequest {
  durationSeconds: number;
  expectedObjectKey: string;
}

export const MAX_VIDEO_DURATION_SECONDS = 31 * 24 * 60 * 60;
export function isVideoDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_VIDEO_DURATION_SECONDS;
}

export interface DeleteVideoResult {
  videoId: string;
  title: string;
  objects: Array<{
    role: "original" | "playback" | "thumbnail";
    objectKey: string;
    bucket: string | null;
    publicUrl: string | null;
  }>;
}
