import assert from "node:assert/strict";
import test from "node:test";
import { assertSafeReleaseFile } from "./release-policy.js";

test("发布检查允许 OSS 配置标签和空字段，不把字段名当成真实凭据", () => {
  assert.doesNotThrow(() => assertSafeReleaseFile("assets/index.js", 'RAM AccessKey AccessKeyId AccessKeySecret; const value = { accessKeyId: "", accessKeySecret: "" };'));
});

test("发布检查拒绝硬编码凭据，错误不回显凭据值", () => {
  const secrets = [
    "LTAI" + "aB12".repeat(5),
    "AKIA" + "A1".repeat(8),
    "ghp_" + "b2".repeat(20),
    'accessKeySecret: "hard-coded-secret"',
    '{"accessKeyId":"hard-coded-id"}',
    "-----BEGIN " + "PRIVATE KEY-----"
  ];
  for (const secret of secrets) assert.throws(() => assertSafeReleaseFile("assets/index.js", secret), error => error instanceof Error && error.message.includes("疑似凭据") && !error.message.includes(secret));
});

test("发布检查继续拒绝开发 Mock、服务端模块和源映射", () => {
  for (const marker of ["demo-password", "ov.dev-mock", "mock-owner", "node:fs", "ali-oss", "auth.key", "nodemailer"])
    assert.throws(() => assertSafeReleaseFile("assets/index.js", marker));
  for (const name of ["assets/index.js.map", "fixtures/demo.mp4", "assets/mock.js"])
    assert.throws(() => assertSafeReleaseFile(name, ""));
});
