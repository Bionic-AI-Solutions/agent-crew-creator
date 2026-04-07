# ── Build frontend ───────────────────────────────────────────
FROM node:22-alpine AS frontend-builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY vite.config.ts tsconfig.json tsconfig.server.json postcss.config.js ./
COPY client/ ./client/
COPY shared/ ./shared/
COPY server/ ./server/
COPY drizzle/ ./drizzle/

RUN npx vite build

# ── Production ───────────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

# Install mc CLI for MinIO admin operations (user/policy management)
RUN wget -q https://dl.min.io/client/mc/release/linux-amd64/mc -O /usr/local/bin/mc && \
    chmod +x /usr/local/bin/mc

COPY package.json package-lock.json ./
RUN npm ci

# Copy server source (run via tsx at runtime)
COPY server/ ./server/
COPY shared/ ./shared/
COPY drizzle/ ./drizzle/

# Copy built frontend
COPY --from=frontend-builder /app/dist/public ./dist/public

EXPOSE 3000
CMD ["npx", "tsx", "server/index.ts"]
