import type { FastifyInstance } from 'fastify';
import type { AuthRepository } from '../modules/auth/authRepository.js';
import type { EmailSender } from '../modules/email/emailSender.js';
import { authRoutes } from './auth.js';
import { healthRoutes } from './health.js';
import type { ChatRepository } from '../modules/chat/chatRepository.js';
import type { AiRouter } from '../modules/ai/modelRouter.js';
import { chatRoutes } from './chat.js';
import { profileRoutes } from './profile.js';
import { settingsRoutes } from './settings.js';

export type RouteOptions = {
  authRepository?: AuthRepository;
  emailSender?: EmailSender;
  chatRepository?: ChatRepository;
  aiRouter?: AiRouter;
};

export async function registerRoutes(app: FastifyInstance, options: RouteOptions) {
  await app.register(healthRoutes, { prefix: '/api/v1' });
  await app.register(authRoutes, {
    prefix: '/api/v1',
    authRepository: options.authRepository,
    emailSender: options.emailSender,
  });
  await app.register(chatRoutes, {
    prefix: '/api/v1',
    authRepository: options.authRepository,
    chatRepository: options.chatRepository,
    aiRouter: options.aiRouter,
  });
  await app.register(profileRoutes, {
    prefix: '/api/v1',
    authRepository: options.authRepository,
  });
  await app.register(settingsRoutes, {
    prefix: '/api/v1',
    authRepository: options.authRepository,
    chatRepository: options.chatRepository,
  });
}
