FROM node:18-slim

# Install native build tools needed for better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends \
	python3 \
	make \
	g++ \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first for better layer caching
COPY package*.json ./
RUN npm ci --omit=dev

# Copy rest of the app
COPY . .

# Set environment variables (add more as needed)
ENV NODE_ENV=production \
	PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
