import { chromium } from "@playwright/test";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

for (const fixture of [{ name: "demo.webm", width: 640, height: 360 }, { name: "portrait.webm", width: 360, height: 640 }]) {
const target = new URL(`./fixtures/${fixture.name}`, import.meta.url);
try { await stat(target); console.log("Mock fixture exists; preserved"); }
catch {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const page = await browser.newPage();
    // tsx 保留函数名的辅助函数不随 evaluate 序列化，明确在隔离的空白测试页补齐。
    await page.addScriptTag({ content: "window.__name = (fn) => fn;" });
    const output = await page.evaluate(async ({ width, height }) => {
      const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext("2d")!;
      ctx.scale(width / 640, height / 360);
      let frame = 0;
      const draw = () => {
        const t = frame++ / 30;
        ctx.fillStyle = "#15261c"; ctx.fillRect(0, 0, 640, 360);
        ctx.fillStyle = "#31513c"; ctx.beginPath(); ctx.moveTo(0, 320); ctx.lineTo(210, 120); ctx.lineTo(380, 320); ctx.fill();
        ctx.fillStyle = "#568259"; ctx.beginPath(); ctx.moveTo(230, 360); ctx.lineTo(470, 160); ctx.lineTo(640, 320); ctx.lineTo(640, 360); ctx.fill();
        ctx.fillStyle = "#d2eea2"; ctx.beginPath(); ctx.arc(450 + Math.sin(t) * 30, 70, 26, 0, Math.PI * 2); ctx.fill();
        ctx.font = "20px sans-serif"; ctx.fillText("PRIVATE LIBRARY / DEVELOPMENT SAMPLE", 24, 42);
        ctx.font = "16px sans-serif"; ctx.fillText(`${Math.min(t, 12).toFixed(1)}s / Synthetic VP8 video`, 24, 338);
      };
      draw(); const stream = canvas.captureStream(30);
      const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8", videoBitsPerSecond: 200000 });
      const chunks: Blob[] = [];
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      const finish = new Promise<Blob>(resolve => { recorder.onstop = () => resolve(new Blob(chunks, { type: "video/webm" })); });
      const timer = setInterval(draw, 1000 / 30); recorder.start(100);
      await new Promise(resolve => setTimeout(resolve, 12000)); recorder.stop(); clearInterval(timer); stream.getTracks().forEach(track => track.stop());
      return Array.from(new Uint8Array(await (await finish).arrayBuffer()));
    }, fixture);
    await mkdir(fileURLToPath(new URL("./fixtures", import.meta.url)), { recursive: true });
    await writeFile(target, Buffer.from(output), { flag: "wx" });
    console.log(`Generated explicit Mock VP8 fixture: ${output.length} bytes`);
  } finally { await browser.close(); }
}
}
