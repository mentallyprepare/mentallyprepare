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

ENV NODE_ENV=production \
    PORT=8080

EXPOSE 8080

# Use shell form so startup errors reach the container logs before exit
CMD node server.js 2>&1
