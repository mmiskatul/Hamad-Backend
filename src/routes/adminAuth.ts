import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config/env.js';
import type {
  AuthRepository,
  SessionRecord,
  UserRecord,
} from '../modules/auth/authRepository.js';
import { AuthError, authenticateUser } from '../modules/auth/authService.js';
import { MongoAuthRepository } from '../modules/auth/mongoAuthRepository.js';
import {
  SessionError,
  SessionService,
  type SessionCredentials,
} from '../modules/auth/sessionService.js';

type AdminAuthRouteOptions = { authRepository?: AuthRepository };
type LoginBody = { email: string; password: string };
type RefreshBody = { refreshToken: string; sessionToken: string };
type LogoutBody = { sessionToken: string };
type SessionParams = { sessionId: string };
type AccessClaims = { sub: string; sid: string };

class AdminAccessError extends Error {
  readonly code = 'ADMIN_ACCESS_REQUIRED' as const;

  constructor(message = 'Administrator access is required.') {
    super(message);
    this.name = 'AdminAccessError';
  }
}

const emailSchema = { type: 'string', format: 'email', maxLength: 254 } as const;
const errorResponseSchema = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
      },
    },
  },
} as const;

export async function adminAuthRoutes(
  app: FastifyInstance,
  options: AdminAuthRouteOptions,
) {
  let repository: AuthRepository | undefined;
  const getRepository = () => {
    repository ??=
      options.authRepository ??
      new MongoAuthRepository(app.mongo.db ?? app.mongo.client.db(env.mongoDatabase));
    return repository;
  };

  let sessions: SessionService | undefined;
  const getSessions = () => {
    sessions ??= new SessionService(
      getRepository(),
      env.jwtSecret,
      env.sessionExpiresDays,
    );
    return sessions;
  };

  const requireAdmin = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
      const claims = request.user as AccessClaims;
      await getSessions().assertActive(claims.sub, claims.sid);
      const user = await getRepository().findUserById(claims.sub);
      if (!user || user.role !== 'admin') throw new AdminAccessError();
    } catch (error) {
      if (error instanceof AdminAccessError) {
        return reply.code(403).send({
          error: { code: error.code, message: error.message },
        });
      }
      if (error instanceof SessionError) {
        return reply.code(401).send({
          error: { code: error.code, message: error.message },
        });
      }
      throw error;
    }
  };

  app.post<{ Body: LoginBody }>(
    '/admin/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['email', 'password'],
          properties: {
            email: emailSchema,
            password: { type: 'string', minLength: 1, maxLength: 256 },
          },
        },
        response: { 401: errorResponseSchema, 403: errorResponseSchema },
      },
    },
    async (request, reply) =>
      handleAdminError(reply, async () => {
        const user = await authenticateUser(
          getRepository(),
          request.body.email,
          request.body.password,
        );
        assertAdmin(user);
        return adminTokenResponse(
          app,
          await getSessions().create(user, {
            userAgent: request.headers['user-agent'],
            ipAddress: request.ip,
          }),
        );
      }),
  );

  app.post<{ Body: RefreshBody }>(
    '/admin/auth/refresh',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['refreshToken', 'sessionToken'],
          properties: {
            refreshToken: { type: 'string', minLength: 20, maxLength: 256 },
            sessionToken: { type: 'string', minLength: 20, maxLength: 256 },
          },
        },
        response: { 401: errorResponseSchema, 403: errorResponseSchema },
      },
    },
    async (request, reply) =>
      handleAdminError(reply, async () => {
        const credentials = await getSessions().refresh(
          request.body.refreshToken,
          request.body.sessionToken,
        );
        try {
          assertAdmin(credentials.user);
        } catch (error) {
          await getSessions().logout(request.body.sessionToken);
          throw error;
        }
        return adminTokenResponse(app, credentials);
      }),
  );

  app.post<{ Body: LogoutBody }>(
    '/admin/auth/logout',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['sessionToken'],
          properties: {
            sessionToken: { type: 'string', minLength: 20, maxLength: 256 },
          },
        },
      },
    },
    async (request, reply) => {
      await getSessions().logout(request.body.sessionToken);
      return reply.code(204).send();
    },
  );

  app.get(
    '/admin/auth/me',
    { onRequest: requireAdmin },
    async (request, reply) => {
      const claims = request.user as AccessClaims;
      const user = await getRepository().findUserById(claims.sub);
      if (!user || user.role !== 'admin') {
        return reply.code(403).send({
          error: {
            code: 'ADMIN_ACCESS_REQUIRED',
            message: 'Administrator access is required.',
          },
        });
      }
      return { user: publicAdmin(user) };
    },
  );

  app.get(
    '/admin/auth/sessions',
    { onRequest: requireAdmin },
    async (request) => {
      const claims = request.user as AccessClaims;
      const active = await getSessions().list(claims.sub);
      return {
        sessions: active.map((session) => publicSession(session, claims.sid)),
      };
    },
  );

  app.delete<{ Params: SessionParams }>(
    '/admin/auth/sessions/:sessionId',
    {
      onRequest: requireAdmin,
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['sessionId'],
          properties: { sessionId: { type: 'string', minLength: 1, maxLength: 100 } },
        },
      },
    },
    async (request, reply) =>
      handleAdminError(reply, async () => {
        const claims = request.user as AccessClaims;
        await getSessions().revoke(claims.sub, request.params.sessionId);
        return reply.code(204).send();
      }),
  );

  app.post(
    '/admin/auth/sessions/revoke-others',
    { onRequest: requireAdmin },
    async (request) => {
      const claims = request.user as AccessClaims;
      return {
        revoked: await getSessions().revokeOthers(claims.sub, claims.sid),
      };
    },
  );
}

function assertAdmin(user: UserRecord): void {
  if (user.role !== 'admin') throw new AdminAccessError();
}

function adminTokenResponse(
  app: FastifyInstance,
  credentials: SessionCredentials,
) {
  const { user, session, refreshToken, sessionToken } = credentials;
  return {
    user: publicAdmin(user),
    accessToken: app.jwt.sign({
      sub: user.id,
      sid: session.id,
      jti: randomUUID(),
      email: user.email,
      name: user.name,
      role: 'admin',
    }),
    refreshToken,
    sessionToken,
    tokenType: 'Bearer',
    expiresIn: env.accessTokenExpiresIn,
    sessionExpiresAt: session.expiresAt.toISOString(),
  };
}

function publicAdmin(user: UserRecord) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: 'admin' as const,
    createdAt: user.createdAt.toISOString(),
  };
}

function publicSession(session: SessionRecord, currentSessionId: string) {
  return {
    id: session.id,
    createdAt: session.createdAt.toISOString(),
    lastUsedAt: session.lastUsedAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
    current: session.id === currentSessionId,
    ...(session.userAgent ? { userAgent: session.userAgent } : {}),
    ...(session.ipAddress ? { ipAddress: session.ipAddress } : {}),
  };
}

async function handleAdminError<T>(
  reply: FastifyReply,
  operation: () => Promise<T>,
): Promise<T | FastifyReply> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AdminAccessError) {
      return reply.code(403).send({
        error: { code: error.code, message: error.message },
      });
    }
    if (error instanceof SessionError) {
      return reply.code(error.code === 'SESSION_NOT_FOUND' ? 404 : 401).send({
        error: { code: error.code, message: error.message },
      });
    }
    if (error instanceof AuthError) {
      return reply.code(401).send({
        error: { code: error.code, message: error.message },
      });
    }
    throw error;
  }
}
