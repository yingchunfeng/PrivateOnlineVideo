import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";

const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const hmac = (key: string | Buffer, value: string) => createHmac("sha256", key).update(value).digest();

/** 仅用于小样例的本机协议替身，不访问阿里云、不模拟云账单或云权限配置。 */
export async function startLocalOss(input: { bucket: string; region: string; prefix: string; accessKeyId: string; accessKeySecret: string; stsToken: string }) {
  const objects = new Map<string, { bytes: Buffer; etag: string; contentType: string }>();
  const uploads = new Map<string, { key: string; contentType: string; parts: Map<number, Buffer> }>();
  const requests: { method: string; key: string; status: number; range: string | null; signed: boolean }[] = [];

  function verifySignedGet(request: IncomingMessage, url: URL, key: string) {
    if (request.method !== "GET" || url.searchParams.get("x-oss-signature-version") !== "OSS4-HMAC-SHA256" ||
      url.searchParams.get("x-oss-security-token") !== input.stsToken || url.searchParams.has("x-oss-additional-headers")) return false;
    const credential = url.searchParams.get("x-oss-credential")?.split("/");
    const date = url.searchParams.get("x-oss-date") ?? "";
    const ttl = Number(url.searchParams.get("x-oss-expires"));
    if (!credential || credential.length !== 5 || credential[0] !== input.accessKeyId || credential[2] !== input.region ||
      credential[3] !== "oss" || credential[4] !== "aliyun_v4_request" || credential[1] !== date.slice(0, 8) ||
      !/^\d{8}T\d{6}Z$/.test(date) || !Number.isInteger(ttl) || ttl < 1 || ttl > 3600) return false;
    const signedAt = Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`);
    if (signedAt > Date.now() + 30_000 || signedAt + ttl * 1000 <= Date.now()) return false;
    const query = [...url.searchParams].filter(([name]) => name !== "x-oss-signature")
      .sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => `${encode(name)}=${encode(value)}`).join("&");
    const canonical = ["GET", encode(`/${input.bucket}/${key}`).replace(/%2F/g, "/"), query, "", "", "UNSIGNED-PAYLOAD"].join("\n");
    const scope = credential.slice(1).join("/");
    const stringToSign = ["OSS4-HMAC-SHA256", date, scope, digest(canonical)].join("\n");
    const dateKey = hmac(`aliyun_v4${input.accessKeySecret}`, credential[1]!);
    const signingKey = hmac(hmac(hmac(dateKey, input.region), "oss"), "aliyun_v4_request");
    const expected = hmac(signingKey, stringToSign).toString("hex");
    const signature = url.searchParams.get("x-oss-signature") ?? "";
    return /^[a-f0-9]{64}$/.test(signature) && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    let key = decodeURIComponent(url.pathname.slice(1));
    if (key.startsWith(`${input.bucket}/`)) key = key.slice(input.bucket.length + 1);
    const signed = url.searchParams.has("x-oss-signature");
    const entry = { method: request.method ?? "GET", key, status: 200, range: request.headers.range ?? null, signed };
    requests.push(entry);
    const finish = (status: number, body = "") => { entry.status = status; response.statusCode = status; response.end(body); };
    const fail = (status: number, code: string) => { response.setHeader("content-type", "application/xml"); finish(status, `<Error><Code>${code}</Code><Message>Local protocol test</Message></Error>`); };
    try {
      const sdkAuthorized = String(request.headers.authorization ?? "").startsWith(`OSS4-HMAC-SHA256 Credential=${input.accessKeyId}/`) && request.headers["x-oss-security-token"] === input.stsToken;
      // SDK请求核查V4头/STS身份；直连GET独立核验完整HMAC、有效期与对象路径。
      if (signed ? !verifySignedGet(request, url, key) : !sdkAuthorized) { fail(403, "AccessDenied"); return; }
      // OSS GetObject不支持以query覆盖Content-Type；替身不能放行真实API拒绝的参数。
      if (url.searchParams.has("response-content-type")) { fail(400, "InvalidRequest"); return; }
      if (key && (!key.startsWith(input.prefix) || key.includes("..") || key.includes("\\"))) { fail(403, "AccessDenied"); return; }
      if (request.method === "POST" && url.searchParams.has("uploads")) {
        const id = randomUUID(); uploads.set(id, { key, contentType: String(request.headers["content-type"] ?? "application/octet-stream"), parts: new Map() });
        response.setHeader("content-type", "application/xml");
        finish(200, `<InitiateMultipartUploadResult><Bucket>${xml(input.bucket)}</Bucket><Key>${xml(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`); return;
      }
      if (request.method === "PUT" && url.searchParams.has("uploadId")) {
        const upload = uploads.get(url.searchParams.get("uploadId")!); const number = Number(url.searchParams.get("partNumber"));
        if (!upload || upload.key !== key || !Number.isInteger(number) || number < 1) { fail(404, "NoSuchUpload"); return; }
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks); upload.parts.set(number, bytes);
        response.setHeader("etag", `"${digest(bytes)}"`); finish(200); return;
      }
      if (request.method === "POST" && url.searchParams.has("uploadId")) {
        const upload = uploads.get(url.searchParams.get("uploadId")!);
        if (!upload || upload.key !== key) { fail(404, "NoSuchUpload"); return; }
        if (objects.has(key)) { fail(409, "FileAlreadyExists"); return; }
        if (request.headers["x-oss-forbid-overwrite"] !== "true") { fail(400, "InvalidArgument"); return; }
        let manifest = ""; for await (const chunk of request) manifest += String(chunk);
        const numbers = [...manifest.matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map(match => Number(match[1]));
        if (!numbers.length || numbers.some(number => !upload.parts.has(number))) { fail(400, "InvalidPart"); return; }
        const bytes = Buffer.concat(numbers.map(number => upload.parts.get(number)!));
        const etag = `"${digest(bytes)}"`; objects.set(key, { bytes, etag, contentType: upload.contentType });
        response.setHeader("content-type", "application/xml");
        finish(200, `<CompleteMultipartUploadResult><Bucket>${xml(input.bucket)}</Bucket><Key>${xml(key)}</Key><ETag>${xml(etag)}</ETag></CompleteMultipartUploadResult>`); return;
      }
      if (request.method === "GET" && url.searchParams.has("list-type")) {
        const prefix = url.searchParams.get("prefix") ?? ""; const limit = Number(url.searchParams.get("max-keys"));
        if (!prefix.startsWith(input.prefix) || !Number.isInteger(limit) || limit < 1 || limit > 100) { fail(403, "AccessDenied"); return; }
        const all = [...objects].filter(([name]) => name.startsWith(prefix)).sort(([left], [right]) => left.localeCompare(right));
        const cursor = Number(url.searchParams.get("continuation-token") ?? 0); const page = all.slice(cursor, cursor + limit); const truncated = cursor + page.length < all.length;
        response.setHeader("content-type", "application/xml");
        finish(200, `<ListBucketResult><Name>${xml(input.bucket)}</Name><Prefix>${xml(prefix)}</Prefix><MaxKeys>${limit}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${cursor + page.length}</NextContinuationToken>` : ""}${page.map(([name, object]) => `<Contents><Key>${xml(name)}</Key><LastModified>2026-10-02T00:00:00.000Z</LastModified><ETag>${xml(object.etag)}</ETag><Size>${object.bytes.length}</Size><StorageClass>Standard</StorageClass></Contents>`).join("")}</ListBucketResult>`); return;
      }
      const object = objects.get(key); if (!object) { fail(404, "NoSuchKey"); return; }
      response.setHeader("etag", object.etag); response.setHeader("content-type", url.searchParams.get("response-content-type") ?? object.contentType); response.setHeader("accept-ranges", "bytes");
      const disposition = url.searchParams.get("response-content-disposition"); if (disposition) response.setHeader("content-disposition", disposition);
      if (request.method === "HEAD") { response.setHeader("content-length", object.bytes.length); finish(200); return; }
      if (request.method !== "GET") { fail(405, "MethodNotAllowed"); return; }
      let bytes = object.bytes;
      if (request.headers.range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
        const start = Number(match?.[1]); const end = match?.[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
        if (!match || start > end || start >= bytes.length) { fail(416, "InvalidRange"); return; }
        response.setHeader("content-range", `bytes ${start}-${end}/${bytes.length}`); bytes = bytes.subarray(start, end + 1); entry.status = 206;
      }
      response.statusCode = entry.status; response.setHeader("content-length", bytes.length); response.end(bytes);
    } catch { if (!response.headersSent) fail(500, "ProtocolFixtureFailure"); else response.destroy(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Local OSS did not listen");
  return { endpoint: `http://127.0.0.1:${address.port}`, objects, uploads, requests,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
