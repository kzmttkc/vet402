# ============================================================
# vet402 — self-host / contributor image (Phase 0.2).
# `docker compose up` で Postgres ごとフルスタックが立つことが受け入れ条件。
# Vercel 本番はこのファイルを使わない（Vercel は自前ビルド）。standalone
# 出力は DOCKER_BUILD=1 のときだけ有効化し、本番ビルドの挙動を変えない。
# ============================================================
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV DOCKER_BUILD=1
ENV NEXT_TELEMETRY_DISABLED=1
# ビルド時に DB は無くてよい: リーダーは db=null で空を返し、ページは
# ランタイムの revalidate で実データに置き換わる。
RUN npm run build

FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 3000
USER node
CMD ["node", "server.js"]
