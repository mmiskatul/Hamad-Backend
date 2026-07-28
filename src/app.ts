import Fastify from 'fastify';
import { env } from './config/env.js';
import { registerRoutes } from './routes/index.js';

export function buildApp() {
  const app = Fastify({
    logger: { level: env.logLevel },
  });

  app.get('/', async () => ({
    name: 'Hamad Backend',
    status: 'running',
    health: '/api/v1/health',
  }));

  app.register(registerRoutes);

  return app;
}
