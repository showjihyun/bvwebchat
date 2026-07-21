# RQ-05 / ADR-0006: 단일 컨테이너 — 정적 클라이언트 + Socket.IO 단일 서버.
# 멀티스테이지: builder에서 client(vite)·server(esbuild 번들)를 빌드하고,
# runtime은 프로덕션 의존성 + dist만 담아 `node dist/server/main.js`로 뜬다.

# ── builder ──
FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:client && npm run build:server

# ── runtime ──
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
# 런타임 의존성만(서버 번들은 socket.io만 external로 요구).
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
# 비루트 실행 (node 이미지 기본 제공 사용자).
USER node
ENV PORT=3001
EXPOSE 3001
CMD ["node", "dist/server/main.js"]
