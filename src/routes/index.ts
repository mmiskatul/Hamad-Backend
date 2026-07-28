import type { FastifyInstance } from 'fastify';
import { healthRoutes } from './health.js';

export async function registerRoutes(app: FastifyInstance) {
  await app.register(healthRoutes, { prefix: '/api/v1' });
}
