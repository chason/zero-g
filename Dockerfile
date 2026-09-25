# syntax=docker/dockerfile:1
# zero-g is a static site once built: a Vite bundle and an index.html. Two stages — build
# it with Node, serve it with nginx — so the image that runs carries no toolchain.
# Coolify: add the repository as a Dockerfile build, port 80. Any Docker host will do.

FROM node:22-alpine AS build
WORKDIR /app
# Dependencies first, so a source-only change reuses the cached install layer.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
# `npm run build` type-checks before bundling, so a build that would not pass CI does not ship.
RUN npm run build

FROM nginx:1.27-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
