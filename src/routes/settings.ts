import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthRepository, UserRecord } from '../modules/auth/authRepository.js';
import { MongoAuthRepository } from '../modules/auth/mongoAuthRepository.js';
import { SessionError, SessionService } from '../modules/auth/sessionService.js';
import type { ChatRepository } from '../modules/chat/chatRepository.js';
import { MongoChatRepository } from '../modules/chat/mongoChatRepository.js';
import { PLAN_LIMITS, PLANS, resolvePlan, type Plan } from '../modules/plans/plans.js';
import { env } from '../config/env.js';

export type SettingsRouteOptions = {
  authRepository?: AuthRepository;
  chatRepository?: ChatRepository;
};

type Claims = { sub: string; sid: string };
type MemoryBody = Partial<{
  enabled: boolean;
  nickname: string;
  occupation: string;
  about: string;
}>;
type SummaryBody = { text: string };
type PlanBody = { plan: Plan };

const defaultMemory = () => ({
  enabled: false,
  nickname: '',
  occupation: '',
  about: '',
  summary: '',
  summaryUpdatedAt: null as Date | null,
});

export async function settingsRoutes(app: FastifyInstance, options: SettingsRouteOptions) {
  let authRepository: AuthRepository | undefined;
  const auth = () => {
    authRepository ??= options.authRepository ?? new MongoAuthRepository(
      app.mongo.db ?? app.mongo.client.db(env.mongoDatabase),
    );
    return authRepository;
  };
  let chatRepository: ChatRepository | undefined;
  const chat = () => {
    chatRepository ??= options.chatRepository ?? new MongoChatRepository(
      app.mongo.db ?? app.mongo.client.db(env.mongoDatabase),
    );
    return chatRepository;
  };
  let sessions: SessionService | undefined;
  const requireSession = async (request: FastifyRequest, reply: FastifyReply) => {
    await request.jwtVerify();
    const claims = request.user as Claims;
    sessions ??= new SessionService(auth(), env.jwtSecret, env.sessionExpiresDays);
    try {
      await sessions.assertActive(claims.sub, claims.sid);
    } catch (error) {
      if (!(error instanceof SessionError)) throw error;
      return reply.code(401).send({ error: { code: error.code, message: error.message } });
    }
  };

  app.get('/settings/memory', { onRequest: requireSession }, async (request, reply) => {
    const user = await currentUser(auth(), request);
    if (!user) return notFound(reply);
    return publicMemory(user.memory ?? defaultMemory());
  });

  app.patch<{ Body: MemoryBody }>(
    '/settings/memory',
    {
      onRequest: requireSession,
      schema: {
        body: {
          type: 'object', additionalProperties: false, minProperties: 1,
          properties: {
            enabled: { type: 'boolean' },
            nickname: { type: 'string', maxLength: 100 },
            occupation: { type: 'string', maxLength: 200 },
            about: { type: 'string', maxLength: 4000 },
          },
        },
      },
    },
    async (request, reply) => updateMemory(auth(), request, reply, request.body),
  );

  app.post<{ Body: SummaryBody }>(
    '/settings/memory/summary',
    {
      onRequest: requireSession,
      schema: {
        body: {
          type: 'object', additionalProperties: false, required: ['text'],
          properties: { text: { type: 'string', minLength: 1, maxLength: 4000, pattern: '.*\\S.*' } },
        },
      },
    },
    async (request, reply) => {
      const user = await currentUser(auth(), request);
      if (!user) return notFound(reply);
      const memory = user.memory ?? defaultMemory();
      const text = request.body.text.trim();
      return updateMemory(auth(), request, reply, {
        summary: memory.summary ? `${memory.summary}\n\n${text}` : text,
        summaryUpdatedAt: new Date(),
      });
    },
  );

  app.delete('/settings/memory/summary', { onRequest: requireSession }, async (request, reply) => {
    const user = await currentUser(auth(), request);
    if (!user) return notFound(reply);
    const memory = user.memory ?? defaultMemory();
    const updated = await auth().updateUserMemory({
      id: userId(request),
      memory: { ...memory, summary: '', summaryUpdatedAt: null },
      updatedAt: new Date(),
    });
    return updated ? reply.code(204).send() : notFound(reply);
  });

  app.get('/usage', { onRequest: requireSession }, async (request, reply) => {
    const user = await currentUser(auth(), request);
    if (!user) return notFound(reply);
    const plan = resolvePlan(user.plan);
    const now = new Date();
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const usage = await chat().aggregateUsage(userId(request), periodStart);
    return {
      periodStart: periodStart.toISOString(),
      plan,
      limits: PLAN_LIMITS[plan],
      ...usage,
    };
  });

  app.patch<{ Body: PlanBody }>(
    '/settings/plan',
    {
      onRequest: requireSession,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['plan'],
          properties: { plan: { type: 'string', enum: [...PLANS] } },
        },
      },
    },
    async (request, reply) => {
      const updated = await auth().updateUserPlan({
        id: userId(request),
        plan: request.body.plan,
        updatedAt: new Date(),
      });
      if (!updated) return notFound(reply);
      const plan = resolvePlan(updated.plan);
      return { plan, limits: PLAN_LIMITS[plan] };
    },
  );

  app.get('/about', async () => ({
    name: 'OneAI Hub',
    version: process.env.npm_package_version ?? '1.0.0',
    apiVersion: 'v1',
    supportEmail: env.smtpFromEmail,
  }));
}

async function updateMemory(
  repository: AuthRepository,
  request: FastifyRequest,
  reply: FastifyReply,
  patch: Partial<NonNullable<UserRecord['memory']>>,
) {
  const user = await currentUser(repository, request);
  if (!user) return notFound(reply);
  const updated = await repository.updateUserMemory({
    id: user.id,
    memory: { ...(user.memory ?? defaultMemory()), ...patch },
    updatedAt: new Date(),
  });
  return updated ? publicMemory(updated.memory ?? defaultMemory()) : notFound(reply);
}

function publicMemory(memory: NonNullable<UserRecord['memory']>) {
  return {
    ...memory,
    summaryUpdatedAt: memory.summaryUpdatedAt?.toISOString() ?? null,
  };
}

function userId(request: FastifyRequest): string {
  return (request.user as Claims).sub;
}

function currentUser(repository: AuthRepository, request: FastifyRequest) {
  return repository.findUserById(userId(request));
}

function notFound(reply: FastifyReply) {
  return reply.code(404).send({ error: { code: 'USER_NOT_FOUND', message: 'User not found.' } });
}
