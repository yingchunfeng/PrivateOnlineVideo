// 受信任本地探针测试替身：不包含视频解码器，不能代表真实 FFprobe/手机样例已验证。
if (process.env.MEDIA_PROBE_FIXTURE_MODE === "timeout") await new Promise(resolve => setTimeout(resolve, 10000));
if (process.env.MEDIA_PROBE_FIXTURE_MODE === "error") process.exit(1);
const url = process.argv.at(-1);
for (const [option, value] of [["-protocol_whitelist", "http,tcp"], ["-format_whitelist", "mov,matroska,webm,avi"], ["-enable_drefs", "0"], ["-use_absolute_path", "0"]]) {
  if (process.argv[process.argv.indexOf(option) + 1] !== value) process.exit(3);
}
if (!/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]{36}$/.test(url)) process.exit(4);
const response = await fetch(url, { headers: { range: "bytes=0-7" } });
if (response.status !== 206 || (await response.arrayBuffer()).byteLength !== 8) process.exit(2);
process.stdout.write(JSON.stringify({ format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "10.5", tags: { major_brand: "isom" } },
  streams: [{ codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p", profile: "High", width: 1920, height: 1080 }, { codec_type: "audio", codec_name: "aac" }] }));
