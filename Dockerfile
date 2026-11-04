# Hugging Face Spaces / Render / any Docker host. The Playwright image ships Chromium and Node 22 (node:sqlite).
FROM mcr.microsoft.com/playwright:v1.64.1-noble
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
# Spaces run as uid 1000: keep the database and run evidence writable.
RUN mkdir -p runs && chmod -R 777 /app
ENV NODE_ENV=production PORT=7860 CHROMIUM_PATH= DB_PATH=/app/playable-promise.db
EXPOSE 7860
CMD ["node", "--no-warnings", "server.js"]
