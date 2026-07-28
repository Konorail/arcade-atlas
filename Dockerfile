FROM node:22-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY VERSION ./VERSION
COPY src ./src
COPY public ./public
COPY views ./views
COPY .env.example ./.env.example

RUN npm run build && npm prune --omit=dev

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "dist/server.js"]
