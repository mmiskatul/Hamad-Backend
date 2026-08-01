# syntax=docker/dockerfile:1

# Shared Node.js base for every stage.
FROM node:22-alpine AS base

WORKDIR /app

# Install the complete dependency graph for development and compilation.
FROM base AS dependencies
COPY package*.json ./
RUN npm ci

# Development image used by Docker Compose with source mounted from the host.
FROM dependencies AS development
ENV NODE_ENV=development
COPY tsconfig*.json ./
CMD ["npm", "run", "dev"]

# Compile only production source files into /app/dist.
FROM dependencies AS builder
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

# Install runtime dependencies without TypeScript or test tooling.
FROM base AS production-dependencies
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Minimal non-root production runtime.
FROM base AS production
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000

COPY --chown=node:node --from=production-dependencies /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist
COPY --chown=node:node package.json ./package.json

USER node
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider "http://127.0.0.1:${PORT}/api/v1/health" || exit 1

CMD ["node", "dist/index.js"]
