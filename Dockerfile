# Stage 1: Build TypeScript artifacts
FROM node:22-alpine AS builder

WORKDIR /app

# Copy dependency manifests
COPY package*.json tsconfig.json ./

# Install all dependencies for compilation (deterministic clean install)
RUN npm ci

# Copy application source and migrations
COPY src/ ./src/
COPY migrations/ ./migrations/

# Compile TypeScript
RUN npm run build

# Stage 2: Production runner
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled JavaScript files to dist/src
COPY --from=builder /app/dist/src ./dist/src

# Copy migrations directory for startup schema migration execution
COPY --from=builder /app/migrations ./migrations

# Security: run application as unprivileged node user
USER node

# Expose HTTP service port
EXPOSE 3000

# Start server using the unified compiled artifact path
CMD ["node", "dist/src/server.js"]
