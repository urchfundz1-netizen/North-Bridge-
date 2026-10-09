# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build stage: install every workspace dependency and produce the SPA bundle.
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS build
WORKDIR /app

# Copy manifests first so the dependency layer is cached independently of the
# source. package-lock.json is required for a reproducible `npm ci`.
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci

COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
# Runtime stage: production dependencies only, plus the server and the built
# client. The SQLite database and uploads live on a volume mounted at /data.
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY --from=build /app/client/dist ./client/dist

# Durable state. `/data` is owned by the unprivileged `node` user so a volume
# mounted here is writable without running the container as root.
RUN mkdir -p /data/uploads && chown -R node:node /data
ENV DATABASE_FILE=/data/northbridge.db \
    UPLOADS_DIR=/data/uploads

USER node
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
