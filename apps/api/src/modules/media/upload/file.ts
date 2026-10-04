import { HttpError } from "../../../core/errors.js";

const videoContentTypes: Record<string, string> = {
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", qt: "video/quicktime", webm: "video/webm",
  ogv: "video/ogg", ogg: "video/ogg", mkv: "video/x-matroska", avi: "video/x-msvideo",
  mpeg: "video/mpeg", mpg: "video/mpeg", mpe: "video/mpeg", ts: "video/mp2t", mts: "video/mp2t", m2ts: "video/mp2t",
  "3gp": "video/3gpp", "3g2": "video/3gpp2", flv: "video/x-flv", wmv: "video/x-ms-wmv", asf: "video/x-ms-asf", vob: "video/mpeg"
};

/** 后缀只决定对象路径和 Content-Type，实际编码兼容性由浏览器判断。 */
export function uploadFileType(fileName: string): { extension: string; contentType: string } {
  if (/[\\/\x00-\x1f]/.test(fileName)) throw new HttpError("VALIDATION_ERROR");
  const extension = /\.([a-z0-9]{1,10})$/i.exec(fileName)?.[1]?.toLowerCase();
  if (!extension || !Object.hasOwn(videoContentTypes, extension)) throw new HttpError("UNSUPPORTED_MEDIA_TYPE");
  return { extension, contentType: videoContentTypes[extension]! };
}
