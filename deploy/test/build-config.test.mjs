import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { rootCertificates } from "node:tls";
import { runInNewContext } from "node:vm";

const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");

function runCertificateBootstrap(existingBundle) {
  const match = dockerfile.match(/^RUN node -e '([\s\S]*?)'\r?$/m);
  assert.ok(match, "the certificate bootstrap must run before APT");
  const operations = [];
  const fs = {
    existsSync(path) { assert.equal(path, "/etc/ssl/certs/ca-certificates.crt"); return existingBundle; },
    mkdirSync(path, options) { operations.push({ type: "mkdir", path, options: { ...options } }); },
    writeFileSync(path, content, options) { operations.push({ type: "write", path, content, options: { ...options } }); }
  };
  runInNewContext(match[1].replace(/\\\r?\n/g, "\n"), {
    require(name) {
      if (name === "node:fs") return fs;
      assert.equal(name, "node:tls");
      return { rootCertificates };
    }
  });
  return operations;
}

test("build stages default to configurable Aliyun package mirrors", () => {
  assert.match(dockerfile, /FROM node-base AS manifests\r?\nARG DEBIAN_MIRROR=https:\/\/mirrors\.aliyun\.com\r?\nARG NPM_REGISTRY=https:\/\/registry\.npmmirror\.com/);
  assert.match(dockerfile, /sed -i "s\|http:\/\/deb\.debian\.org\|\$\{DEBIAN_MIRROR\}\|g" \/etc\/apt\/sources\.list\.d\/debian\.sources/);
  assert.doesNotMatch(dockerfile, /trusted=yes|AllowInsecureRepositories|Verify-Peer=false|Verify-Host=false|strict-ssl=false|NODE_TLS_REJECT_UNAUTHORIZED/);
});

test("a missing system trust bundle is bootstrapped from Node's bundled root CAs", () => {
  const operations = runCertificateBootstrap(false);
  assert.equal(operations.length, 2);
  assert.deepEqual(operations[0], { type: "mkdir", path: "/etc/ssl/certs", options: { recursive: true } });
  const bundle = operations[1];
  assert.equal(bundle.type, "write");
  assert.equal(bundle.path, "/etc/ssl/certs/ca-certificates.crt");
  assert.equal(bundle.content, rootCertificates.join("\n") + "\n");
  assert.deepEqual(bundle.options, { flag: "wx", mode: 0o644 });
  assert.ok(rootCertificates.length > 0);
  for (const certificate of rootCertificates) assert.ok(new X509Certificate(certificate).ca);
});

test("an existing system trust bundle is not overwritten", () => {
  assert.deepEqual(runCertificateBootstrap(true), []);
});

test("APT uses the seeded trust bundle and installs the Debian CA package", () => {
  assert.ok(dockerfile.indexOf("RUN node -e") < dockerfile.indexOf("timeout 180s apt-get"));
  assert.equal(dockerfile.split("Acquire::https::CAInfo=/etc/ssl/certs/ca-certificates.crt").length - 1, 2);
  assert.match(dockerfile, /install -y --no-install-recommends ca-certificates python3 make g\+\+/);
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
