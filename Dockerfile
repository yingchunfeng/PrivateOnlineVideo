# syntax=docker/dockerfile:1

ARG NODE_IMAGE=node:22-bookworm-slim
ARG NGINX_IMAGE=nginx:stable-alpine

FROM ${NODE_IMAGE} AS node-base
WORKDIR /app

FROM node-base AS manifests
ARG DEBIAN_MIRROR=https://mirrors.aliyun.com
ARG NPM_REGISTRY=https://registry.npmmirror.com
# Bootstrap APT's HTTPS trust from Node's bundled CAs without replacing an existing bundle.
RUN node -e 'const fs = require("node:fs"); \
    const path = "/etc/ssl/certs/ca-certificates.crt"; \
    if (!fs.existsSync(path)) { \
        fs.mkdirSync("/etc/ssl/certs", { recursive: true }); \
        fs.writeFileSync(path, require("node:tls").rootCertificates.join("\n") + "\n", { flag: "wx", mode: 0o644 }); \
    }'
# Native dependencies must be installed for Linux, not copied from Windows.
RUN sed -i "s|http://deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && timeout 180s apt-get -o Acquire::ForceIPv4=true -o Acquire::Retries=1 \
        -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 \
        -o Acquire::https::CAInfo=/etc/ssl/certs/ca-certificates.crt \
        -o APT::Update::Error-Mode=any update \
    && timeout 600s apt-get -o Acquire::ForceIPv4=true -o Acquire::Retries=1 \
        -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 \
        -o Acquire::https::CAInfo=/etc/ssl/certs/ca-certificates.crt \
        install -y --no-install-recommends ca-certificates python3 make g++
RUN npm install --global npm@10.9.4 --registry="${NPM_REGISTRY}"
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/shared/package.json ./packages/shared/package.json
# Compile native addons against this image's headers instead of downloading them again.
ENV npm_config_nodedir=/usr/local
RUN test -s /usr/local/include/node/node.h \
    && test -s /usr/local/include/node/node_version.h \
    && test -s /usr/local/include/node/common.gypi \
    && test -s /usr/local/include/node/config.gypi

FROM manifests AS dependencies
RUN npm ci --registry="${NPM_REGISTRY}" --no-audit --no-fund

FROM dependencies AS api-build
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api
RUN npm run build -w @online-video/shared && npm run build -w @online-video/api

FROM dependencies AS web-build
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web
RUN npm run build -w @online-video/shared && npm run build -w @online-video/web

FROM manifests AS production-dependencies
RUN npm ci --registry="${NPM_REGISTRY}" --omit=dev --no-audit --no-fund

FROM node-base AS api
ENV NODE_ENV=production API_HOST=0.0.0.0 API_PORT=3000
COPY --from=production-dependencies /app/package.json ./package.json
COPY --from=production-dependencies /app/node_modules ./node_modules
# Preserve workspace links and any workspace-local runtime dependencies.
COPY --from=production-dependencies /app/apps ./apps
COPY --from=production-dependencies /app/packages ./packages
COPY --from=api-build /app/apps/api/dist ./apps/api/dist
COPY --from=api-build /app/packages/shared/dist ./packages/shared/dist
COPY docs/sql/NEW_INSTALL_FULL.sql ./docs/sql/NEW_INSTALL_FULL.sql
COPY deploy/init-db.mjs ./deploy/init-db.mjs
COPY deploy/deployment.json.example ./config/deployment.json
RUN mkdir -p /app/.local/data && chown -R node:node /app/.local
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/setup-server.js"]

FROM ${NGINX_IMAGE} AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
