import { decode } from "jpeg-js";
import { HttpError } from "../../../core/errors.js";

export const MAX_COVER_BYTES = 2 * 1024 * 1024;
export const MAX_COVER_EDGE = 960;

/** 首版只接收浏览器重编码的 JPEG；先限制尺寸，再实际解码，不能把伪装文件当作封面。 */
export function inspectCoverImage(bytes: Buffer): { width: number; height: number; contentType: "image/jpeg" } {
  if (bytes.length > MAX_COVER_BYTES) throw new HttpError("PAYLOAD_TOO_LARGE");
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) {
    throw new HttpError("UNSUPPORTED_MEDIA_TYPE");
  }
  let offset = 2; let width = 0; let height = 0;
  while (offset < bytes.length - 2) {
    if (bytes[offset] !== 0xff) throw new HttpError("VALIDATION_ERROR");
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0 || marker === 0xd8 || marker === 0xd9) throw new HttpError("VALIDATION_ERROR");
    if (marker === 0xda) break;
    if (offset + 2 > bytes.length) throw new HttpError("VALIDATION_ERROR");
    const size = bytes.readUInt16BE(offset);
    if (size < 2 || offset + size > bytes.length - 2) throw new HttpError("VALIDATION_ERROR");
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (width || size < 8 || bytes[offset + 2] !== 8) throw new HttpError("VALIDATION_ERROR");
      height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5);
      if (!width || !height || width > MAX_COVER_EDGE || height > MAX_COVER_EDGE) throw new HttpError("VALIDATION_ERROR");
    }
    offset += size;
  }
  if (!width || !height) throw new HttpError("VALIDATION_ERROR");
  try {
    const decoded = decode(bytes, { useTArray: true, formatAsRGBA: false, tolerantDecoding: false,
      maxResolutionInMP: 1, maxMemoryUsageInMB: 32 });
    if (decoded.width !== width || decoded.height !== height || decoded.data.length !== width * height * 3) throw new Error("invalid image");
  } catch { throw new HttpError("VALIDATION_ERROR"); }
  return { width, height, contentType: "image/jpeg" };
}
