# Бэкенд Dubli — сборка и запуск.
# --- build ---
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build

# --- runtime ---
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY db ./db
COPY scripts/db-apply.mjs ./scripts/db-apply.mjs
EXPOSE 3000
# Идемпотентно применяем схему (с ретраем на старт БД), затем запускаем сервер.
CMD ["sh", "-c", "node scripts/db-apply.mjs && node dist/main.js"]
