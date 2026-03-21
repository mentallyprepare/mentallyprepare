# Dockerfile for Node.js app
FROM node:18-alpine
RUN apk add --no-cache python3 make g++ py3-setuptools
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
