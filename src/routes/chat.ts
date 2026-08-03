import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AiRouter } from '../modules/ai/modelRouter.js';
import { createDefaultAiRouter } from '../modules/ai/aiServiceRouter.js';
import type { AuthRepository } from '../modules/auth/authRepository.js';
import { MongoAuthRepository } from '../modules/auth/mongoAuthRepository.js';
import { SessionError, SessionService } from '../modules/auth/sessionService.js';
import type {
  ChatRepository,
  ModelId,
  ResponseLanguage,
} from '../modules/chat/chatRepository.js';
import { MODEL_IDS, RESPONSE_LANGUAGES } from '../modules/chat/chatRepository.js';
import { ChatError, ChatService } from '../modules/chat/chatService.js';
import { MongoChatRepository } from '../modules/chat/mongoChatRepository.js';
import { env } from '../config/env.js';
import { AttachmentStorage } from '../modules/chat/attachmentStorage.js';

export type ChatRouteOptions = {
  authRepository?: AuthRepository;
  chatRepository?: ChatRepository;
  aiRouter?: AiRouter;
};

type AccessClaims = { sub: string; sid: string };
type ConversationProjectBody = { id: string; name: string };
type ConversationParams = { conversationId: string };
type AttachmentParams = ConversationParams & { attachmentId: string };
type CreateConversationBody = {
  id?: string;
  title?: string;
  modelId: ModelId;
  responseLanguage?: ResponseLanguage;
  project?: ConversationProjectBody;
};
type UpdateConversationBody = Partial<
  Pick<CreateConversationBody, 'title' | 'modelId' | 'responseLanguage'> & { pinned: boolean }
>;
type SendMessageBody = {
  clientMessageId: string;
  content: string;
  modelId: ModelId;
  responseLanguage?: ResponseLanguage;
  project?: ConversationProjectBody;
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

const conversationIdSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['conversationId'],
  properties: { conversationId: { type: 'string', minLength: 3, maxLength: 100 } },
} as const;

const attachmentIdSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['conversationId', 'attachmentId'],
  properties: {
    conversationId: { type: 'string', minLength: 3, maxLength: 100 },
    attachmentId: { type: 'string', minLength: 3, maxLength: 100 },
  },
} as const;

const projectSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 100 },
    name: { type: 'string', minLength: 1, maxLength: 120 },
  },
} as const;

export async function chatRoutes(app: FastifyInstance, options: ChatRouteOptions) {
  const attachments = new AttachmentStorage(env.attachmentStorageDir);
  let authRepository: AuthRepository | undefined;
  const getAuthRepository = () => {
    authRepository ??=
      options.authRepository ??
      new MongoAuthRepository(app.mongo.db ?? app.mongo.client.db(env.mongoDatabase));
    return authRepository;
  };

  let chatRepository: ChatRepository | undefined;
  const getChatRepository = () => {
    chatRepository ??=
      options.chatRepository ??
      new MongoChatRepository(app.mongo.db ?? app.mongo.client.db(env.mongoDatabase));
    return chatRepository;
  };

  let service: ChatService | undefined;
  const getService = () => {
    service ??= new ChatService(
      getChatRepository(),
      options.aiRouter ?? createDefaultAiRouter(),
      env.aiMaxContextMessages,
      async (userId) => (await getAuthRepository().findUserById(userId))?.memory ?? null,
    );
    return service;
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

  app.get('/models', { onRequest: requireActiveSession }, async (_request, reply) =>
    handleChatError(reply, async () => ({ models: await getService().models() })),
  );

  app.get('/conversations', { onRequest: requireActiveSession }, async (request) => ({
    conversations: (await getService().listConversations(userId(request))).map(publicConversation),
  }));

  app.post<{ Body: CreateConversationBody }>(
    '/conversations',
    {
      onRequest: requireActiveSession,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['modelId'],
          properties: {
            id: { type: 'string', minLength: 3, maxLength: 100 },
            title: { type: 'string', minLength: 1, maxLength: 200 },
            modelId: { type: 'string', enum: [...MODEL_IDS] },
            responseLanguage: { type: 'string', enum: [...RESPONSE_LANGUAGES] },
            project: projectSchema,
          },
        },
        response: { 503: errorSchema },
      },
    },
    async (request, reply) => handleChatError(reply, async () =>
      reply.code(201).send(publicConversation(await getService().createConversation({
        ...request.body,
        userId: userId(request),
        responseLanguage: request.body.responseLanguage ?? 'auto',
      }))),
    ),
  );

  app.get<{ Params: ConversationParams }>(
    '/conversations/:conversationId',
    {
      onRequest: requireActiveSession,
      schema: { params: conversationIdSchema, response: { 404: errorSchema } },
    },
    async (request, reply) => handleChatError(reply, async () => ({
      conversation: publicConversation(
        await getService().getConversation(userId(request), request.params.conversationId),
      ),
      messages: (await getService().getMessages(userId(request), request.params.conversationId)).map(publicMessage),
    })),
  );

  app.get<{ Params: ConversationParams }>(
    '/conversations/:conversationId/messages',
    { onRequest: requireActiveSession, schema: { params: conversationIdSchema, response: { 404: errorSchema } } },
    async (request, reply) => handleChatError(reply, async () => ({
      messages: (await getService().getMessages(userId(request), request.params.conversationId)).map(publicMessage),
    })),
  );

  app.patch<{ Params: ConversationParams; Body: UpdateConversationBody }>(
    '/conversations/:conversationId',
    {
      onRequest: requireActiveSession,
      schema: {
        params: conversationIdSchema,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 200 },
            modelId: { type: 'string', enum: [...MODEL_IDS] },
            responseLanguage: { type: 'string', enum: [...RESPONSE_LANGUAGES] },
            pinned: { type: 'boolean' },
          },
        },
        response: { 404: errorSchema, 503: errorSchema },
      },
    },
    async (request, reply) => handleChatError(reply, async () => publicConversation(
      await getService().updateConversation(userId(request), request.params.conversationId, request.body),
    )),
  );

  app.delete<{ Params: ConversationParams }>(
    '/conversations/:conversationId',
    { onRequest: requireActiveSession, schema: { params: conversationIdSchema, response: { 404: errorSchema } } },
    async (request, reply) => handleChatError(reply, async () => {
      await getService().deleteConversation(userId(request), request.params.conversationId);
      await attachments.removeConversation(userId(request), request.params.conversationId);
      return reply.code(204).send();
    }),
  );

  app.get<{ Params: ConversationParams }>(
    '/conversations/:conversationId/attachments',
    { onRequest: requireActiveSession, schema: { params: conversationIdSchema, response: { 404: errorSchema } } },
    async (request, reply) => handleChatError(reply, async () => {
      await getService().getConversation(userId(request), request.params.conversationId);
      return {
        attachments: (await attachments.list(userId(request), request.params.conversationId))
          .map(publicAttachment),
      };
    }),
  );

  app.post<{ Params: ConversationParams }>(
    '/conversations/:conversationId/attachments',
    { onRequest: requireActiveSession, schema: { params: conversationIdSchema, response: { 404: errorSchema } } },
    async (request, reply) => handleChatError(reply, async () => {
      await getService().getConversation(userId(request), request.params.conversationId);
      const part = await request.file();
      if (!part) throw new ChatError('ATTACHMENT_REQUIRED', 'Choose an image or document to upload.', 400);
      let data: Buffer;
      try {
        data = await part.toBuffer();
      } catch (error) {
        if (error instanceof app.multipartErrors.RequestFileTooLargeError) {
          throw new ChatError(
            'ATTACHMENT_TOO_LARGE',
            `Attachments must be ${Math.floor(env.attachmentMaxBytes / 1024 / 1024)} MB or smaller.`,
            413,
          );
        }
        throw error;
      }
      if (!data.byteLength) throw new ChatError('ATTACHMENT_EMPTY', 'The selected file is empty.', 400);
      const attachment = await attachments.save(userId(request), request.params.conversationId, {
        name: part.filename,
        mimeType: part.mimetype,
        data,
      });
      return reply.code(201).send({ attachment: publicAttachment(attachment) });
    }),
  );

  app.get<{ Params: AttachmentParams }>(
    '/conversations/:conversationId/attachments/:attachmentId/content',
    { onRequest: requireActiveSession, schema: { params: attachmentIdSchema, response: { 404: errorSchema } } },
    async (request, reply) => handleChatError(reply, async () => {
      await getService().getConversation(userId(request), request.params.conversationId);
      const file = await attachments.read(
        userId(request),
        request.params.conversationId,
        request.params.attachmentId,
      );
      if (!file) throw new ChatError('ATTACHMENT_NOT_FOUND', 'Attachment not found.', 404);
      const disposition = file.record.mimeType.startsWith('image/') ? 'inline' : 'attachment';
      reply
        .type(file.record.mimeType)
        .header('Content-Length', file.record.size)
        .header('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(file.record.name)}`);
      return reply.send(file.data);
    }),
  );

  app.delete<{ Params: AttachmentParams }>(
    '/conversations/:conversationId/attachments/:attachmentId',
    { onRequest: requireActiveSession, schema: { params: attachmentIdSchema, response: { 404: errorSchema } } },
    async (request, reply) => handleChatError(reply, async () => {
      await getService().getConversation(userId(request), request.params.conversationId);
      const removed = await attachments.remove(
        userId(request),
        request.params.conversationId,
        request.params.attachmentId,
      );
      if (!removed) throw new ChatError('ATTACHMENT_NOT_FOUND', 'Attachment not found.', 404);
      return reply.code(204).send();
    }),
  );

  app.post<{ Params: ConversationParams; Body: SendMessageBody }>(
    '/conversations/:conversationId/messages',
    {
      onRequest: requireActiveSession,
      schema: {
        params: conversationIdSchema,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['clientMessageId', 'content', 'modelId'],
          properties: {
            clientMessageId: { type: 'string', minLength: 3, maxLength: 100 },
            content: { type: 'string', minLength: 1, maxLength: 50000, pattern: '.*\\S.*' },
            modelId: { type: 'string', enum: [...MODEL_IDS] },
            responseLanguage: { type: 'string', enum: [...RESPONSE_LANGUAGES] },
            project: projectSchema,
          },
        },
        response: { 404: errorSchema, 502: errorSchema, 503: errorSchema },
      },
    },
    async (request, reply) => handleChatError(reply, async () => {
      const result = await getService().sendMessage({
        ...request.body,
        userId: userId(request),
        conversationId: request.params.conversationId,
        responseLanguage: request.body.responseLanguage ?? 'auto',
      });
      return reply.code(201).send({
        conversation: publicConversation(result.conversation),
        userMessage: publicMessage(result.userMessage),
        assistantMessage: publicMessage(result.assistantMessage),
      });
    }),
  );
}

function userId(request: FastifyRequest): string {
  return (request.user as AccessClaims).sub;
}

function publicConversation(record: Awaited<ReturnType<ChatService['createConversation']>>) {
  return {
    ...record,
    pinnedAt: record.pinnedAt ? record.pinnedAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function publicMessage(record: Awaited<ReturnType<ChatRepository['appendMessage']>>) {
  return { ...record, createdAt: record.createdAt.toISOString() };
}

function publicAttachment(record: {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  createdAt: Date;
}) {
  return { ...record, createdAt: record.createdAt.toISOString() };
}

async function handleChatError(reply: FastifyReply, action: () => Promise<unknown>) {
  try {
    return await action();
  } catch (error) {
    if (!(error instanceof ChatError)) throw error;
    return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
  }
}
