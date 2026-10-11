# syntax=docker/dockerfile:1

# Build once on the runner's own architecture: the output is plain static files,
# so there's no reason to run npm under emulation for every target platform.
#
# Both base images are pinned by digest as well as tag: a tag can be re-pointed, a digest cannot,
# so the image that passed CI is the image that ships. Dependabot keeps the digests current; the
# Node version is the one CI and `.nvmrc` use, so the build here is the build that was tested.
FROM --platform=$BUILDPLATFORM node:26.10.0-bookworm-slim@sha256:662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2 AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

COPY . .
# dist/ carries THIRD_PARTY_LICENSES.txt (vite.config.ts), the notices the shipped packages require.
RUN npm run build

# The runtime is just nginx and the built app: no Node, no node_modules, no source. The unprivileged
# image runs nginx as its own non-root user on a high port, so nothing in the container ever has
# root — a listener on 80 would need it, which is why the port is 8080 (map it however you like:
# `-p 80:8080`).
FROM nginxinc/nginx-unprivileged:1.30-alpine@sha256:ed04ec1ff34502c339ee5c3ae3f855442398edc1d05591e2b98981dcbbd20b1e

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:8080/ || exit 1
