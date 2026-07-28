# Hamad Backend

Minimal Fastify 5 TypeScript starter for the Hamad platform backend.

## Structure

src/
  app.ts               Fastify application factory
  index.ts             Server entry point
  config/              Environment and application configuration
  routes/              HTTP route plugins
tests/                 Node test runner tests

## Run locally

```bash
npm install
npm run dev
```

The server listens on http://localhost:4000 by default.

- GET / returns service metadata
- GET /api/v1/health returns the health status

## Docker

```bash
docker compose up --build
```

The production image is built with `docker build --target production .`.
