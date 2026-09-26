# syntax=docker/dockerfile:1

# Build once on the runner's own architecture: the output is plain static files,
# so there's no reason to run npm under emulation for every target platform.
FROM --platform=$BUILDPLATFORM node:26.9.0-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

COPY . .
RUN npm run build

# The runtime is just nginx and the built app: no Node, no node_modules, no source.
FROM nginx:1.30-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -q --spider http://127.0.0.1/ || exit 1
