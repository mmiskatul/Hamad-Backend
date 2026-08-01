import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import type {
  AuthRepository,
  SessionRecord,
  UserRecord,
} from '../modules/auth/authRepository.js';
import { AuthError, AuthService, normaliseEmail } from '../modules/auth/authService.js';
import { MongoAuthRepository } from '../modules/auth/mongoAuthRepository.js';
import {
  SessionError,
  SessionService,
  type SessionCredentials,
} from '../modules/auth/sessionService.js';
import type { EmailSender } from '../modules/email/emailSender.js';
import { SmtpEmailSender } from '../modules/email/smtpEmailSender.js';
import { env } from '../config/env.js';

type AuthRouteOptions = {
  authRepository?: AuthRepository;
  emailSender?: EmailSender;
};

type EmailBody = { email: string };
type VerifyCodeBody = EmailBody & { code: string };
type LoginBody = EmailBody & { password: string };
type RefreshBody = { refreshToken: string; sessionToken: string };
type LogoutBody = { sessionToken: string };
type SessionParams = { sessionId: string };
type RegisterBody = EmailBody & {
  name: string;
  password: string;
  verificationToken: string;
};

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

const publicUserSchema = {
  type: 'object',
  required: ['id', 'email', 'name', 'createdAt'],
  properties: {
    id: { type: 'string' },
    email: { type: 'string' },
    name: { type: 'string' },
    createdAt: { type: 'string' },
  },
} as const;

const authenticatedResponseSchema = {
  type: 'object',
  required: [
    'user',
    'accessToken',
    'refreshToken',
    'sessionToken',
    'tokenType',
    'expiresIn',
    'sessionExpiresAt',
  ],
  properties: {
    user: publicUserSchema,
    accessToken: { type: 'string' },
    refreshToken: { type: 'string' },
    sessionToken: { type: 'string' },
    tokenType: { type: 'string' },
    expiresIn: { type: 'string' },
    sessionExpiresAt: { type: 'string' },
  },
} as const;

const sessionSchema = {
  type: 'object',
  required: ['id', 'createdAt', 'lastUsedAt', 'expiresAt', 'current'],
  properties: {
    id: { type: 'string' },
    createdAt: { type: 'string' },
    lastUsedAt: { type: 'string' },
    expiresAt: { type: 'string' },
    current: { type: 'boolean' },
    userAgent: { type: 'string' },
    ipAddress: { type: 'string' },
  },
} as const;

type AccessClaims = {
  sub: string;
  sid: string;
  email: string;
  name: string;
  createdAt: string;
};

export async function authRoutes(app: FastifyInstance, options: AuthRouteOptions) {
  let repository: AuthRepository | undefined;
  const getRepository = () => {
    if (repository) return repository;
    repository =
      options.authRepository ??
      new MongoAuthRepository(
        app.mongo.db ?? app.mongo.client.db(env.mongoDatabase),
      );
    return repository;
  };

  let service: AuthService | undefined;
  const getService = () => {
    if (service) return service;
    const emailSender =
      options.emailSender ??
      new SmtpEmailSender({
        host: env.smtpHost,
        port: env.smtpPort,
        secure: env.smtpSecure,
        user: env.smtpUser,
        password: env.smtpPassword,
        fromEmail: env.smtpFromEmail,
        fromName: env.smtpFromName,
      });
    service = new AuthService(getRepository(), {
      verificationSecret: env.jwtSecret,
      verificationCodeExpiresMinutes: env.emailVerificationCodeExpiresMinutes,
      emailSender,
    });
    return service;
  };

  let sessionService: SessionService | undefined;
  const getSessionService = () => {
    sessionService ??= new SessionService(
      getRepository(),
      env.jwtSecret,
      env.sessionExpiresDays,
    );
    return sessionService;
  };

  app.post<{ Body: EmailBody }>(
    '/auth/check-email',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['email'],
          properties: { email: emailSchema },
        },
      },
    },
    async (request) => {
      const email = normaliseEmail(request.body.email);
      return { email, registered: await getService().checkEmail(email) };
    },
  );

  app.post<{ Body: EmailBody }>(
    '/auth/registration/request-code',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['email'],
          properties: { email: emailSchema },
        },
        response: {
          202: {
            type: 'object',
            required: ['email', 'sent', 'expiresInSeconds'],
            properties: {
              email: { type: 'string' },
              sent: { type: 'boolean' },
              expiresInSeconds: { type: 'number' },
            },
          },
          409: errorResponseSchema,
          502: errorResponseSchema,
        },
      },
    },
    async (request, reply) =>
      handleAuthError(reply, async () => {
        const result = await getService().requestRegistrationCode(request.body.email);
        app.log.info({ email: result.email }, 'Registration verification code issued');
        return reply.code(202).send({
          email: result.email,
          sent: true,
          expiresInSeconds: result.expiresInSeconds,
        });
      }),
  );

  app.post<{ Body: VerifyCodeBody }>(
    '/auth/registration/verify-code',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['email', 'code'],
          properties: {
            email: emailSchema,
            code: { type: 'string', pattern: '^[0-9]{4}$' },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['verificationToken'],
            properties: { verificationToken: { type: 'string' } },
          },
          400: errorResponseSchema,
        },
      },
    },
    async (request, reply) =>
      handleAuthError(reply, async () => ({
        verificationToken: await getService().verifyRegistrationCode(
          request.body.email,
          request.body.code,
        ),
      })),
  );

  app.post<{ Body: RegisterBody }>(
    '/auth/registration',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['email', 'name', 'password', 'verificationToken'],
          properties: {
            email: emailSchema,
            name: { type: 'string', minLength: 1, maxLength: 100, pattern: '.*\\S.*' },
            password: { type: 'string', minLength: 8, maxLength: 256 },
            verificationToken: { type: 'string', minLength: 20, maxLength: 200 },
          },
        },
        response: {
          201: {
            ...authenticatedResponseSchema,
          },
          400: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) =>
      handleAuthError(reply, async () => {
        const user = await getService().register(request.body);
        return reply.code(201).send(
          await authenticatedResponse(
            app,
            getSessionService(),
            user,
            request,
          ),
        );
      }),
  );

  app.post<{ Body: LoginBody }>(
    '/auth/login',
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
        response: {
          200: authenticatedResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) =>
      handleAuthError(reply, async () =>
        authenticatedResponse(
          app,
          getSessionService(),
          await getService().login(request.body.email, request.body.password),
          request,
        ),
      ),
  );

  app.post<{ Body: RefreshBody }>(
    '/auth/refresh',
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
        response: {
          200: authenticatedResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) =>
      handleAuthError(reply, async () =>
        tokenResponse(
          app,
          await getSessionService().refresh(
            request.body.refreshToken,
            request.body.sessionToken,
          ),
        ),
      ),
  );

  app.post<{ Body: LogoutBody }>(
    '/auth/logout',
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
      await getSessionService().logout(request.body.sessionToken);
      return reply.code(204).send();
    },
  );

  app.get(
    '/auth/sessions',
    {
      onRequest: async (request) => request.jwtVerify(),
      schema: {
        response: {
          200: {
            type: 'object',
            required: ['sessions'],
            properties: {
              sessions: { type: 'array', items: sessionSchema },
            },
          },
        },
      },
    },
    async (request) => {
      const claims = request.user as AccessClaims;
      const sessions = await getSessionService().list(claims.sub);
      return {
        sessions: sessions.map((session) => publicSession(session, claims.sid)),
      };
    },
  );

  app.delete<{ Params: SessionParams }>(
    '/auth/sessions/:sessionId',
    {
      onRequest: async (request) => request.jwtVerify(),
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['sessionId'],
          properties: { sessionId: { type: 'string', minLength: 1, maxLength: 100 } },
        },
        response: { 404: errorResponseSchema },
      },
    },
    async (request, reply) =>
      handleAuthError(reply, async () => {
        const claims = request.user as AccessClaims;
        await getSessionService().revoke(claims.sub, request.params.sessionId);
        return reply.code(204).send();
      }),
  );

  app.get(
    '/auth/me',
    {
      onRequest: async (request) => request.jwtVerify(),
      schema: { response: { 200: { type: 'object', required: ['user'], properties: { user: publicUserSchema } } } },
    },
    async (request) => {
      const claims = request.user as AccessClaims;
      return {
        user: {
          id: claims.sub,
          email: claims.email,
          name: claims.name,
          createdAt: claims.createdAt,
        },
      };
    },
  );
}

async function authenticatedResponse(
  app: FastifyInstance,
  sessions: SessionService,
  user: UserRecord,
  request: FastifyRequest,
) {
  return tokenResponse(
    app,
    await sessions.create(user, {
      userAgent: request.headers['user-agent'],
      ipAddress: request.ip,
    }),
  );
}

function tokenResponse(app: FastifyInstance, credentials: SessionCredentials) {
  const { user, session, refreshToken, sessionToken } = credentials;
  const userResponse = publicUser(user);
  return {
    user: userResponse,
    accessToken: app.jwt.sign({
      sub: user.id,
      sid: session.id,
      jti: randomUUID(),
      email: user.email,
      name: user.name,
      createdAt: userResponse.createdAt,
    }),
    refreshToken,
    sessionToken,
    tokenType: 'Bearer',
    expiresIn: env.accessTokenExpiresIn,
    sessionExpiresAt: session.expiresAt.toISOString(),
  };
}

function publicUser(user: UserRecord) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
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

async function handleAuthError<T>(
  reply: FastifyReply,
  operation: () => Promise<T>,
): Promise<T | FastifyReply> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SessionError) {
      const status = error.code === 'SESSION_NOT_FOUND' ? 404 : 401;
      return reply.code(status).send({
        error: { code: error.code, message: error.message },
      });
    }
    if (!(error instanceof AuthError)) throw error;
    const status =
      error.code === 'EMAIL_ALREADY_REGISTERED'
        ? 409
        : error.code === 'INVALID_CREDENTIALS'
          ? 401
          : error.code === 'EMAIL_DELIVERY_FAILED'
            ? 502
            : 400;
    return reply.code(status).send({
      error: { code: error.code, message: error.message },
    });
  }
}
