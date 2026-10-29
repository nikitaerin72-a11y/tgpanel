FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

# данные (dumps/, media/, *.json) живут вне кода
ENV DATA_DIR=/data
RUN mkdir -p /data && chmod -R 777 /data

# HF Spaces требует uid 1000 и порт из app_port
USER 1000
EXPOSE 7860

CMD ["node", "server.js"]
