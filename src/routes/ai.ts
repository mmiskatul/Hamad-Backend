import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthRepository } from '../modules/auth/authRepository.js';
import { MongoAuthRepository } from '../modules/auth/mongoAuthRepository.js';
import { SessionError, SessionService } from '../modules/auth/sessionService.js';
import type { AiRouter } from '../modules/ai/modelRouter.js';
import { ModelUnavailableError, ProviderRequestError } from '../modules/ai/modelRouter.js';
import { createDefaultAiRouter } from '../modules/ai/aiServiceRouter.js';
import { AiGatewayService } from '../modules/ai/gatewayService.js';
import type { ModelId, ResponseLanguage } from '../modules/chat/chatRepository.js';
import { MODEL_IDS, RESPONSE_LANGUAGES } from '../modules/chat/chatRepository.js';
import { env } from '../config/env.js';

export type AiRouteOptions = {
  authRepository?: AuthRepository;
  aiRouter?: AiRouter;
};

type AccessClaims = { sub: string; sid: string };
type PromptMessage = {
  role: 'user' | 'assistant';
  content: string;
};

type GenerateBody = {
  modelId: ModelId;
  prompt?: string;
  messages?: PromptMessage[];
  responseLanguage?: ResponseLanguage;
};

const errorSchema = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: { code: { type: 'string' }, message: { type: 'string' } },
    },
  },
} as const;

const promptMessageSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['role', 'content'],
  properties: {
    role: { type: 'string', enum: ['user', 'assistant'] },
    content: { type: 'string', minLength: 1, maxLength: 50_000, pattern: '.*\\S.*' },
  },
} as const;

const generateBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['modelId'],
  properties: {
    modelId: { type: 'string', enum: [...MODEL_IDS] },
    prompt: { type: 'string', minLength: 1, maxLength: 50_000, pattern: '.*\\S.*' },
    responseLanguage: { type: 'string', enum: [...RESPONSE_LANGUAGES] },
    messages: { type: 'array', minItems: 1, maxItems: 50, items: promptMessageSchema },
  },
} as const;

export async function aiRoutes(app: FastifyInstance, options: AiRouteOptions) {
  let authRepository: AuthRepository | undefined;
  const getAuthRepository = () => {
    authRepository ??=
      options.authRepository ??
      new MongoAuthRepository(app.mongo.db ?? app.mongo.client.db(env.mongoDatabase));
    return authRepository;
  };

  let gateway: AiGatewayService | undefined;
  const getGateway = () => {
    gateway ??= new AiGatewayService(
      options.aiRouter ?? createDefaultAiRouter(),
      async (userId) => (await getAuthRepository().findUserById(userId))?.memory ?? null,
    );
    return gateway;
  };

  let sessions: SessionService | undefined;
  const requireActiveSession = async (request: FastifyRequest, reply: FastifyReply) => {
    await request.jwtVerify();
    const claims = request.user as AccessClaims;
    sessions ??= new SessionService(getAuthRepository(), env.jwtSecret, env.sessionExpiresDays);
    try {
      await sessions.assertActive(claims.sub, claims.sid);
    } catch (error) {
      if (!(error instanceof SessionError)) throw error;
      return reply.code(401).send({ error: { code: error.code, message: error.message } });
    }
  };

  app.get('/ai/models', { onRequest: requireActiveSession }, async (request, reply) =>
    handleAiError(reply, async () => {
      const current = await currentUser(getAuthRepository(), request);
      if (!current) return notFound(reply);
      return { models: await getGateway().catalogue() };
    }),
  );

  app.post<{ Body: GenerateBody }>(
    '/ai/responses',
    {
      onRequest: requireActiveSession,
      schema: {
        body: generateBodySchema,
        response: { 400: errorSchema, 404: errorSchema, 502: errorSchema, 503: errorSchema },
      },
    },
    async (request, reply) => handleAiError(reply, async () => {
      const current = await currentUser(getAuthRepository(), request);
      if (!current) return notFound(reply);
      const messages = getGateway().normalizeMessages(request.body.prompt, request.body.messages);
      if (messages.length === 0) {
        return reply.code(400).send({
          error: { code: 'INVALID_PROMPT', message: 'Provide a prompt or at least one message.' },
        });
      }
      const result = await getGateway().generate({
        userId: current.id,
        modelId: request.body.modelId,
        messages,
        responseLanguage: request.body.responseLanguage ?? 'auto',
      });
      return getGateway().toResponse(result);
    }),
  );

  app.post<{ Body: GenerateBody }>(
    '/ai/chat/completions',
    {
      onRequest: requireActiveSession,
      schema: {
        body: generateBodySchema,
        response: { 400: errorSchema, 404: errorSchema, 502: errorSchema, 503: errorSchema },
      },
    },
    async (request, reply) => handleAiError(reply, async () => {
      const current = await currentUser(getAuthRepository(), request);
      if (!current) return notFound(reply);
      const messages = getGateway().normalizeMessages(request.body.prompt, request.body.messages);
      if (messages.length === 0) {
        return reply.code(400).send({
          error: { code: 'INVALID_PROMPT', message: 'Provide a prompt or at least one message.' },
        });
      }
      const result = await getGateway().generate({
        userId: current.id,
        modelId: request.body.modelId,
        messages,
        responseLanguage: request.body.responseLanguage ?? 'auto',
      });
      return getGateway().toChatCompletion(result);
    }),
  );
}

async function currentUser(repository: AuthRepository, request: FastifyRequest) {
  return repository.findUserById((request.user as AccessClaims).sub);
}

function notFound(reply: FastifyReply) {
  return reply.code(404).send({ error: { code: 'USER_NOT_FOUND', message: 'User not found.' } });
}

async function handleAiError(reply: FastifyReply, action: () => Promise<unknown>) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ModelUnavailableError) {
      return reply.code(503).send({ error: { code: error.code, message: error.message } });
    }
    if (error instanceof ProviderRequestError) {
      return reply.code(502).send({ error: { code: error.code, message: error.message } });
    }
    throw error;
  }
}
