# Render / any Docker host. The Playwright image ships Chromium and Node 22 (needed for node:sqlite).
FROM mcr.microsoft.com/playwright:v1.64.1-noble
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production PORT=10000 CHROMIUM_PATH=
EXPOSE 10000
CMD ["node", "--no-warnings", "server.js"]
