import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthRepository } from '../modules/auth/authRepository.js';
import { MongoAuthRepository } from '../modules/auth/mongoAuthRepository.js';
import { SessionError, SessionService } from '../modules/auth/sessionService.js';
import type { ProjectRepository, ProjectScope } from '../modules/projects/projectRepository.js';
import { MongoProjectRepository } from '../modules/projects/mongoProjectRepository.js';
import { ProjectError, ProjectService } from '../modules/projects/projectService.js';
import { env } from '../config/env.js';

export type ProjectsRouteOptions = {
  authRepository?: AuthRepository;
  projectRepository?: ProjectRepository;
};

type Claims = { sub: string; sid: string };
type ProjectParams = { projectId: string };
type ProjectSourceParams = ProjectParams & { sourceId: string };
type CreateProjectBody = { name: string; scope: ProjectScope; description?: string; instructions?: string };
type UpdateProjectBody = Partial<Pick<CreateProjectBody, 'name' | 'scope' | 'description' | 'instructions'>> & { pinned?: boolean };
type AddSourceBody = { name: string; uri?: string };

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

const sourceSchema = {
  type: 'object',
  required: ['id', 'name', 'at', 'uri'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    at: { type: 'string' },
    uri: { type: 'string' },
  },
} as const;

const projectSchema = {
  type: 'object',
  required: ['id', 'name', 'description', 'instructions', 'scope', 'pinned', 'shared', 'sources', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    instructions: { type: 'string' },
    scope: { type: 'string', enum: ['default', 'project-only'] },
    pinned: { type: 'boolean' },
    shared: { type: 'boolean' },
    sources: { type: 'array', items: sourceSchema },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
} as const;

export async function projectsRoutes(app: FastifyInstance, options: ProjectsRouteOptions) {
  let authRepository: AuthRepository | undefined;
  const auth = () => {
    authRepository ??= options.authRepository ?? new MongoAuthRepository(app.mongo.db ?? app.mongo.client.db(env.mongoDatabase));
    return authRepository;
  };

  let projectRepository: ProjectRepository | undefined;
  const projects = () => {
    projectRepository ??= options.projectRepository ?? new MongoProjectRepository(app.mongo.db ?? app.mongo.client.db(env.mongoDatabase));
    return projectRepository;
  };

  let service: ProjectService | undefined;
  const getService = () => (service ??= new ProjectService(projects()));

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

  app.get('/projects', { onRequest: requireSession }, async (request, reply) =>
    handleProjectError(reply, async () => ({ projects: await getService().list(userId(request)) })),
  );

  app.get<{ Params: ProjectParams }>(
    '/projects/:projectId',
    { onRequest: requireSession, schema: { response: { 200: projectSchema, 404: errorSchema } } },
    async (request, reply) => handleProjectError(reply, async () => getService().get(userId(request), request.params.projectId)),
  );

  app.post<{ Body: CreateProjectBody }>(
    '/projects',
    {
      onRequest: requireSession,
      schema: {
        body: {
          type: 'object', additionalProperties: false, required: ['name', 'scope'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 120, pattern: '.*\\S.*' },
            scope: { type: 'string', enum: ['default', 'project-only'] },
            description: { type: 'string', maxLength: 300 },
            instructions: { type: 'string', maxLength: 4000 },
          },
        },
        response: { 201: projectSchema },
      },
    },
    async (request, reply) => handleProjectError(reply, async () =>
      reply.code(201).send(await getService().create({ ...request.body, userId: userId(request) })),
    ),
  );

  app.patch<{ Params: ProjectParams; Body: UpdateProjectBody }>(
    '/projects/:projectId',
    {
      onRequest: requireSession,
      schema: {
        body: {
          type: 'object', additionalProperties: false, minProperties: 1,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 120, pattern: '.*\\S.*' },
            scope: { type: 'string', enum: ['default', 'project-only'] },
            description: { type: 'string', maxLength: 300 },
            instructions: { type: 'string', maxLength: 4000 },
            pinned: { type: 'boolean' },
          },
        },
        response: { 200: projectSchema, 404: errorSchema },
      },
    },
    async (request, reply) => handleProjectError(reply, async () =>
      getService().update(userId(request), request.params.projectId, request.body),
    ),
  );

  app.delete<{ Params: ProjectParams }>(
    '/projects/:projectId',
    { onRequest: requireSession, schema: { response: { 404: errorSchema } } },
    async (request, reply) => handleProjectError(reply, async () => {
      await getService().delete(userId(request), request.params.projectId);
      return reply.code(204).send();
    }),
  );

  app.post<{ Params: ProjectParams; Body: AddSourceBody }>(
    '/projects/:projectId/sources',
    {
      onRequest: requireSession,
      schema: {
        body: {
          type: 'object', additionalProperties: false, required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200, pattern: '.*\\S.*' },
            uri: { type: 'string', maxLength: 2048 },
          },
        },
        response: { 200: projectSchema, 404: errorSchema },
      },
    },
    async (request, reply) => handleProjectError(reply, async () =>
      getService().addSource(userId(request), request.params.projectId, request.body),
    ),
  );

  app.delete<{ Params: ProjectSourceParams }>(
    '/projects/:projectId/sources/:sourceId',
    {
      onRequest: requireSession,
      schema: { response: { 200: projectSchema, 404: errorSchema } },
    },
    async (request, reply) => handleProjectError(reply, async () =>
      getService().removeSource(userId(request), request.params.projectId, request.params.sourceId),
    ),
  );
}

function userId(request: FastifyRequest): string {
  return (request.user as Claims).sub;
}

async function handleProjectError(reply: FastifyReply, action: () => Promise<unknown>) {
  try {
    return await action();
  } catch (error) {
    if (!(error instanceof ProjectError)) throw error;
    return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
  }
}
