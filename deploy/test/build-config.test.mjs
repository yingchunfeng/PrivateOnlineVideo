import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");

test("build stages default to configurable Aliyun package mirrors", () => {
  assert.match(dockerfile, /FROM node-base AS manifests\r?\nARG DEBIAN_MIRROR=https:\/\/mirrors\.aliyun\.com\r?\nARG NPM_REGISTRY=https:\/\/registry\.npmmirror\.com/);
  assert.match(dockerfile, /sed -i "s\|http:\/\/deb\.debian\.org\|\$\{DEBIAN_MIRROR\}\|g" \/etc\/apt\/sources\.list\.d\/debian\.sources/);
  assert.doesNotMatch(dockerfile, /trusted=yes|AllowInsecureRepositories|Verify-Peer=false|strict-ssl=false/);
});

test("APT index updates and dependency installation have bounded IPv4 requests", () => {
  assert.match(dockerfile, /timeout 180s apt-get/);
  assert.match(dockerfile, /timeout 600s apt-get/);
  for (const option of ["Acquire::ForceIPv4=true", "Acquire::Retries=1", "Acquire::http::Timeout=30", "Acquire::https::Timeout=30"]) {
    assert.equal(dockerfile.split(option).length - 1, 2, option);
  }
  assert.match(dockerfile, /APT::Update::Error-Mode=any update/);
});

test("global npm and both locked dependency installs use the selected registry", () => {
  const commands = dockerfile.split(/\r?\n/).filter(line => /^RUN npm (?:install|ci)\b/.test(line));
  assert.equal(commands.length, 3);
  for (const command of commands) assert.ok(command.includes('--registry="${NPM_REGISTRY}"'), command);
  assert.match(dockerfile, /FROM manifests AS dependencies/);
  assert.match(dockerfile, /FROM manifests AS production-dependencies/);
});

test("base image sources remain official and configurable without a public proxy", () => {
  assert.match(dockerfile, /ARG NODE_IMAGE=node:22-bookworm-slim/);
  assert.match(dockerfile, /ARG NGINX_IMAGE=nginx:stable-alpine/);
  assert.match(dockerfile, /FROM \$\{NODE_IMAGE\} AS node-base/);
  assert.match(dockerfile, /FROM \$\{NGINX_IMAGE\} AS web/);
});
