FROM node:18-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev

COPY . .

# Create the DB directory at build time so it always exists
RUN mkdir -p /data/db

ENV NODE_ENV=production

EXPOSE 8080

CMD ["node", "server.js"]
