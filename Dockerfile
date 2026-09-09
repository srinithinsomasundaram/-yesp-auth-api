FROM node:22-alpine AS builder
WORKDIR /app

RUN apk add --no-cache python3 make g++ openssl

COPY package.json ./
COPY prisma ./prisma
# prisma generate reads the schema but does not connect to the DB
# Use a dummy URL so postinstall succeeds without real credentials
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" npm install

COPY . .
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" npx prisma generate && \
    DATABASE_URL="postgresql://build:build@localhost:5432/build" npx tsc --project tsconfig.build.json

# ── Production image ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

RUN apk add --no-cache openssl wget

ENV NODE_ENV=production

COPY package.json ./
COPY prisma ./prisma
# Same dummy URL for generate — real DATABASE_URL is injected at runtime by the platform
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" npm install --omit=dev

COPY --from=builder /app/dist ./dist

EXPOSE 3100

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- "http://localhost:${PORT:-3100}/health" | grep -q '"ok"' || exit 1

# DATABASE_URL must be set as a runtime environment variable in your deployment platform
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/src/index.js"]
