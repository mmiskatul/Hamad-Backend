import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthRepository } from '../modules/auth/authRepository.js';
import { MongoAuthRepository } from '../modules/auth/mongoAuthRepository.js';
import { SessionError, SessionService } from '../modules/auth/sessionService.js';
import { env } from '../config/env.js';
import type { SupportRepository } from '../modules/support/supportRepository.js';
import { MongoSupportRepository } from '../modules/support/mongoSupportRepository.js';
import { SupportService } from '../modules/support/supportService.js';

export type SupportRouteOptions = {
  authRepository?: AuthRepository;
  supportRepository?: SupportRepository;
};

type AccessClaims = { sub: string; sid: string; email: string; name: string };
type CreateTicketBody = { subject: string; message: string };

export async function supportRoutes(app: FastifyInstance, options: SupportRouteOptions) {
  let authRepository: AuthRepository | undefined;
  const auth = () => {
    authRepository ??=
      options.authRepository ??
      new MongoAuthRepository(app.mongo.db ?? app.mongo.client.db(env.mongoDatabase));
    return authRepository;
  };

  let supportRepository: SupportRepository | undefined;
  const support = () => {
    supportRepository ??=
      options.supportRepository ??
      new MongoSupportRepository(app.mongo.db ?? app.mongo.client.db(env.mongoDatabase));
    return supportRepository;
  };

  const service = () => new SupportService(support());

  let sessions: SessionService | undefined;
  const requireActiveSession = async (request: FastifyRequest, reply: FastifyReply) => {
    await request.jwtVerify();
    const claims = request.user as AccessClaims;
    sessions ??= new SessionService(auth(), env.jwtSecret, env.sessionExpiresDays);
    try {
      await sessions.assertActive(claims.sub, claims.sid);
    } catch (error) {
      if (!(error instanceof SessionError)) throw error;
      return reply.code(401).send({ error: { code: error.code, message: error.message } });
    }
  };

  app.post<{ Body: CreateTicketBody }>(
    '/support/tickets',
    {
      onRequest: requireActiveSession,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['subject', 'message'],
          properties: {
            subject: { type: 'string', minLength: 1, maxLength: 200, pattern: '.*\\S.*' },
            message: { type: 'string', minLength: 1, maxLength: 10000, pattern: '.*\\S.*' },
          },
        },
      },
    },
    async (request, reply) => {
      const claims = request.user as AccessClaims;
      const ticket = await service().submit({
        userId: claims.sub,
        email: claims.email,
        name: claims.name,
        subject: request.body.subject,
        message: request.body.message,
      });
      return reply.code(201).send({ ticket });
    },
  );
}
