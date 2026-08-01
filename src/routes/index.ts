import type { FastifyInstance } from 'fastify';
import type { AuthRepository } from '../modules/auth/authRepository.js';
import type { EmailSender } from '../modules/email/emailSender.js';
import { authRoutes } from './auth.js';
import { healthRoutes } from './health.js';

export type RouteOptions = {
  authRepository?: AuthRepository;
  emailSender?: EmailSender;
};

export async function registerRoutes(app: FastifyInstance, options: RouteOptions) {
  await app.register(healthRoutes, { prefix: '/api/v1' });
  await app.register(authRoutes, {
    prefix: '/api/v1',
    authRepository: options.authRepository,
    emailSender: options.emailSender,
  });
}
