FROM oven/bun:1-alpine

WORKDIR /app

RUN apk add --no-cache docker-cli

COPY package*.json bun.lockb ./

RUN bun install --production

COPY src/ ./src/
COPY data/ ./data/
COPY tsconfig.json ./

RUN mkdir -p /app/data

CMD ["bun", "run", "src/main.ts"]