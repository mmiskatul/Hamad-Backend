import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthRepository } from '../modules/auth/authRepository.js';
import { MongoAuthRepository } from '../modules/auth/mongoAuthRepository.js';
import { SessionError, SessionService } from '../modules/auth/sessionService.js';
import { env } from '../config/env.js';

export type AiServiceProxyRouteOptions = {
  authRepository?: AuthRepository;
};

type AccessClaims = { sub: string; sid: string };
type ProxyParams = { '*': string };

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

export async function aiServiceProxyRoutes(
  app: FastifyInstance,
  options: AiServiceProxyRouteOptions,
) {
  let authRepository: AuthRepository | undefined;
  const getAuthRepository = () => {
    authRepository ??=
      options.authRepository ??
      new MongoAuthRepository(app.mongo.db ?? app.mongo.client.db(env.mongoDatabase));
    return authRepository;
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

  app.all<{ Params: ProxyParams }>(
    '/ai-service/*',
    {
      onRequest: requireActiveSession,
      schema: { response: { 502: errorSchema, 503: errorSchema } },
    },
    async (request, reply) => {
      if (!env.aiServiceBaseUrl) {
        return reply.code(503).send({
          error: {
            code: 'AI_SERVICE_NOT_CONFIGURED',
            message: 'AI_SERVICE_BASE_URL is not configured.',
          },
        });
      }

      const claims = request.user as AccessClaims;
      const upstreamUrl = buildUpstreamUrl(env.aiServiceBaseUrl, request.params['*'], request.url);
      try {
        const upstreamResponse = await fetch(upstreamUrl, {
          method: request.method,
          headers: buildForwardHeaders(request, claims),
          body: request.method === 'GET' || request.method === 'HEAD'
            ? undefined
            : JSON.stringify(request.body ?? {}),
        });

        return sendUpstreamResponse(reply, upstreamResponse);
      } catch {
        return reply.code(502).send({
          error: {
            code: 'AI_SERVICE_UNAVAILABLE',
            message: 'AI service is not reachable.',
          },
        });
      }
    },
  );
}

function buildUpstreamUrl(baseUrl: string, path: string, originalUrl: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  const normalizedPath = path.replace(/^\/+/, '');
  const query = originalUrl.includes('?') ? originalUrl.slice(originalUrl.indexOf('?')) : '';
  return `${normalizedBase}/${normalizedPath}${query}`;
}

function buildForwardHeaders(request: FastifyRequest, claims: AccessClaims): Headers {
  const headers = new Headers();
  const authorization = request.headers.authorization;
  const accept = request.headers.accept;
  const contentType = request.headers['content-type'];

  if (authorization) headers.set('authorization', authorization);
  if (accept) headers.set('accept', Array.isArray(accept) ? accept[0] : accept);
  if (contentType) headers.set('content-type', Array.isArray(contentType) ? contentType[0] : contentType);
  headers.set('x-authenticated-user-id', claims.sub);
  headers.set('x-authenticated-session-id', claims.sid);

  return headers;
}

async function sendUpstreamResponse(reply: FastifyReply, upstreamResponse: Response) {
  const contentType = upstreamResponse.headers.get('content-type');
  const body = await upstreamResponse.text();

  if (contentType) reply.header('content-type', contentType);
  reply.code(upstreamResponse.status);

  if (!body) return reply.send();
  if (contentType?.toLowerCase().includes('application/json')) {
    return reply.send(JSON.parse(body));
  }
  return reply.send(body);
}
