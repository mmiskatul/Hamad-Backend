import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import mongodb from '@fastify/mongodb';
import { env } from './config/env.js';
import type { AuthRepository } from './modules/auth/authRepository.js';
import type { EmailSender } from './modules/email/emailSender.js';
import { registerRoutes } from './routes/index.js';

export type BuildAppOptions = {
  authRepository?: AuthRepository;
  emailSender?: EmailSender;
};

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({
    logger: { level: env.logLevel },
  });

  app.register(cors, { origin: '*' });
  app.register(jwt, {
    secret: env.jwtSecret,
    sign: { expiresIn: env.accessTokenExpiresIn },
  });
  if (!options.authRepository) {
    app.register(mongodb, {
      url: env.mongoUrl,
      database: env.mongoDatabase,
      forceClose: true,
    });
  }

  app.get('/', async () => ({
    name: 'Hamad Backend',
    status: 'running',
    health: '/api/v1/health',
  }));

  app.register(registerRoutes, {
    authRepository: options.authRepository,
    emailSender: options.emailSender,
  });

  return app;
}
