import Fastify, { LogController } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import mongodb from '@fastify/mongodb';
import multipart from '@fastify/multipart';
import { env, hasAdminBootstrapConfiguration } from './config/env.js';
import type { AuthRepository } from './modules/auth/authRepository.js';
import type { EmailSender } from './modules/email/emailSender.js';
import { registerRoutes } from './routes/index.js';
import type { ChatRepository } from './modules/chat/chatRepository.js';
import type { AiRouter } from './modules/ai/modelRouter.js';
import type { ProjectRepository } from './modules/projects/projectRepository.js';
import type { SupportRepository } from './modules/support/supportRepository.js';
import { MongoAuthRepository } from './modules/auth/mongoAuthRepository.js';
import { bootstrapAdminAccount } from './modules/auth/adminBootstrap.js';

export type BuildAppOptions = {
  authRepository?: AuthRepository;
  emailSender?: EmailSender;
  chatRepository?: ChatRepository;
  aiRouter?: AiRouter;
  projectRepository?: ProjectRepository;
  supportRepository?: SupportRepository;
};

export function buildApp(options: BuildAppOptions = {}) {
  const prettyLogs = process.env.NODE_ENV !== 'production';
  const app = Fastify({
    logger: {
      level: env.logLevel,
      ...(prettyLogs
        ? {
            transport: {
              target: 'pino-pretty',
              options: {
                colorize: true,
                translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
                ignore: 'pid,hostname',
                singleLine: true,
              },
            },
          }
        : {}),
    },
    logController: new LogController({ disableRequestLogging: true }),
  });

  app.addHook('onRequest', async (request) => {
    request.log.info({
      method: request.method,
      path: request.url,
      clientIp: request.ip,
    }, 'request started');
  });

  app.addHook('onResponse', async (request, reply) => {
    request.log.info({
      method: request.method,
      path: request.url,
      statusCode: reply.statusCode,
      responseTimeMs: Number(reply.elapsedTime.toFixed(1)),
    }, 'request completed');
  });

  app.addHook('onError', async (request, reply, error) => {
    const statusCode = typeof error.statusCode === 'number'
      ? error.statusCode
      : reply.statusCode >= 400
        ? reply.statusCode
        : 500;
    const details = {
      method: request.method,
      path: request.url,
      statusCode,
      error: {
        name: error.name,
        code: 'code' in error ? error.code : undefined,
        message: error.message,
        ...(statusCode >= 500 ? { stack: error.stack } : {}),
      },
    };
    if (statusCode >= 500) request.log.error(details, 'request failed');
    else request.log.warn(details, 'request rejected');
  });

  app.register(cors, { origin: '*' });
  app.register(jwt, {
    secret: env.jwtSecret,
    sign: { expiresIn: env.accessTokenExpiresIn },
  });
  app.register(multipart, {
    limits: { files: 1, fileSize: env.attachmentMaxBytes },
  });
  if (!options.authRepository) {
    app.register(mongodb, {
      url: env.mongoUrl,
      database: env.mongoDatabase,
      forceClose: true,
    });
  }

  if (!options.authRepository) {
    app.addHook('onReady', async () => {
      if (!hasAdminBootstrapConfiguration()) return;
      const repository = new MongoAuthRepository(
        app.mongo.db ?? app.mongo.client.db(env.mongoDatabase),
      );
      const result = await bootstrapAdminAccount(repository, {
        email: env.adminSeedEmail,
        password: env.adminSeedPassword,
        name: env.adminSeedName,
      });
      app.log.info(
        { email: result.user.email, created: result.created },
        result.created ? 'admin account created' : 'admin account already exists',
      );
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
    chatRepository: options.chatRepository,
    aiRouter: options.aiRouter,
    projectRepository: options.projectRepository,
    supportRepository: options.supportRepository,
  });

  return app;
}
