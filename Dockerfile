FROM node:22-alpine AS builder
WORKDIR /app

RUN apk add --no-cache python3 make g++ openssl

ARG DATABASE_URL
ENV DATABASE_URL=$DATABASE_URL

COPY package.json ./
COPY prisma ./prisma
RUN npm install

COPY . .
RUN npx prisma generate && npm run build

# ── Production image ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

RUN apk add --no-cache openssl wget

ARG DATABASE_URL
ENV DATABASE_URL=$DATABASE_URL
ENV NODE_ENV=production

COPY package.json ./
COPY prisma ./prisma
RUN npm install --omit=dev && npx prisma generate

COPY --from=builder /app/dist ./dist

# Nimbuz (and most platforms) inject $PORT — the API picks it up via process.env.PORT
EXPOSE 3100

# Health check on whichever port the platform assigns
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- "http://localhost:${PORT:-3100}/health" | grep -q '"ok"' || exit 1

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
