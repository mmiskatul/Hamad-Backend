import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthRepository } from '../modules/auth/authRepository.js';
import { MongoAuthRepository } from '../modules/auth/mongoAuthRepository.js';
import { SessionError, SessionService } from '../modules/auth/sessionService.js';
import { ProfileError, ProfileService } from '../modules/profile/profileService.js';
import { env } from '../config/env.js';

export type ProfileRouteOptions = { authRepository?: AuthRepository };
type AccessClaims = { sub: string; sid: string };
type UpdateProfileBody = {
  name?: string;
  email?: string;
  phone?: string;
  avatarUri?: string | null;
};

const profileSchema = {
  type: 'object',
  required: ['id', 'name', 'email', 'phone', 'avatarUri', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    email: { type: 'string' },
    phone: { type: 'string' },
    avatarUri: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
} as const;

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

export async function profileRoutes(app: FastifyInstance, options: ProfileRouteOptions) {
  let repository: AuthRepository | undefined;
  const getRepository = () => {
    repository ??=
      options.authRepository ??
      new MongoAuthRepository(app.mongo.db ?? app.mongo.client.db(env.mongoDatabase));
    return repository;
  };
  let service: ProfileService | undefined;
  const getService = () => (service ??= new ProfileService(getRepository()));
  let sessions: SessionService | undefined;

  const requireActiveSession = async (request: FastifyRequest, reply: FastifyReply) => {
    await request.jwtVerify();
    const claims = request.user as AccessClaims;
    sessions ??= new SessionService(getRepository(), env.jwtSecret, env.sessionExpiresDays);
    try {
      await sessions.assertActive(claims.sub, claims.sid);
    } catch (error) {
      if (!(error instanceof SessionError)) throw error;
      return reply.code(401).send({ error: { code: error.code, message: error.message } });
    }
  };

  app.get(
    '/profile',
    { onRequest: requireActiveSession, schema: { response: { 200: profileSchema, 404: errorSchema } } },
    async (request, reply) => handleProfileError(reply, () =>
      getService().get((request.user as AccessClaims).sub),
    ),
  );

  app.patch<{ Body: UpdateProfileBody }>(
    '/profile',
    {
      onRequest: requireActiveSession,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 100, pattern: '.*\\S.*' },
            email: { type: 'string', format: 'email', maxLength: 254 },
            phone: { type: 'string', maxLength: 30 },
            avatarUri: { anyOf: [{ type: 'string', minLength: 1, maxLength: 2048 }, { type: 'null' }] },
          },
        },
        response: { 200: profileSchema, 404: errorSchema, 409: errorSchema },
      },
    },
    async (request, reply) => handleProfileError(reply, () =>
      getService().update((request.user as AccessClaims).sub, request.body),
    ),
  );
}

async function handleProfileError(reply: FastifyReply, action: () => Promise<unknown>) {
  try {
    return await action();
  } catch (error) {
    if (!(error instanceof ProfileError)) throw error;
    return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
  }
}
