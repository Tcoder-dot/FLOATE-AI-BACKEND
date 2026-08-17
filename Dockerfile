# Multi-stage Dockerfile for Node.js Express + Vite + Grammy Telegram Bot
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package manifests
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy application source code
COPY . .

# Build Vite frontend assets and esbuild production server bundle
RUN npm run build

# Production stage
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy built distribution assets from builder stage
COPY --from=builder /app/dist ./dist

# Expose port 3000
EXPOSE 3000

# Start server
CMD ["node", "dist/server.cjs"]
