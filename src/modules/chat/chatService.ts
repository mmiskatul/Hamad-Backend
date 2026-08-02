import { randomUUID } from 'node:crypto';
import type { AiRouter, GenerateResult, ModelCatalogueItem } from '../ai/modelRouter.js';
import { ModelUnavailableError, ProviderRequestError } from '../ai/modelRouter.js';
import type {
  ChatRepository,
  ConversationProject,
  ConversationRecord,
  MessageRecord,
  ModelId,
  ResponseLanguage,
} from './chatRepository.js';

export class ChatError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'ChatError';
  }
}

export type SendMessageInput = {
  userId: string;
  conversationId: string;
  clientMessageId: string;
  content: string;
  modelId: ModelId;
  responseLanguage: ResponseLanguage;
  project?: ConversationProject | null;
};

export type SendMessageResult = {
  conversation: ConversationRecord;
  userMessage: MessageRecord;
  assistantMessage: MessageRecord;
};

export class ChatService {
  constructor(
    private readonly repository: ChatRepository,
    private readonly aiRouter: AiRouter,
    private readonly maxContextMessages: number,
    private readonly loadMemory?: (userId: string) => Promise<{
      enabled: boolean;
      nickname: string;
      occupation: string;
      about: string;
      summary: string;
    } | null>,
  ) {}

  async models(): Promise<ModelCatalogueItem[]> {
    try {
      return await this.aiRouter.catalogue();
    } catch (error) {
      if (error instanceof ProviderRequestError) {
        throw new ChatError(error.code, error.message, 502);
      }
      throw error;
    }
  }

  listConversations(userId: string): Promise<ConversationRecord[]> {
    return this.repository.listConversations(userId);
  }

  getConversation(userId: string, conversationId: string): Promise<ConversationRecord> {
    return this.requireConversation(userId, conversationId);
  }

  async createConversation(input: {
    id?: string;
    userId: string;
    title?: string;
    modelId: ModelId;
    responseLanguage: ResponseLanguage;
    project?: ConversationProject | null;
  }): Promise<ConversationRecord> {
    await this.assertModelAvailable(input.modelId);
    const now = new Date();
    return this.repository.createConversation({
      id: input.id ?? randomUUID(),
      userId: input.userId,
      title: cleanTitle(input.title ?? 'New chat'),
      modelId: input.modelId,
      responseLanguage: input.responseLanguage,
      pinned: false,
      pinnedAt: null,
      project: cleanProject(input.project),
      createdAt: now,
      updatedAt: now,
    });
  }

  async getMessages(userId: string, conversationId: string): Promise<MessageRecord[]> {
    await this.requireConversation(userId, conversationId);
    return this.repository.listMessages(userId, conversationId, 200);
  }

  async updateConversation(
    userId: string,
    conversationId: string,
    patch: { title?: string; modelId?: ModelId; responseLanguage?: ResponseLanguage; pinned?: boolean },
  ): Promise<ConversationRecord> {
    if (patch.modelId) await this.assertModelAvailable(patch.modelId);
    const existing = await this.requireConversation(userId, conversationId);
    const now = new Date();
    const updated = await this.repository.updateConversation(userId, conversationId, {
      ...(patch.title === undefined ? {} : { title: cleanTitle(patch.title) }),
      ...(patch.modelId === undefined ? {} : { modelId: patch.modelId }),
      ...(patch.responseLanguage === undefined
        ? {}
        : { responseLanguage: patch.responseLanguage }),
      ...(patch.pinned === undefined
        ? {}
        : {
            pinned: patch.pinned,
            pinnedAt: patch.pinned ? existing.pinnedAt ?? now : null,
          }),
      updatedAt: now,
    });
    if (!updated) throw new ChatError('CONVERSATION_NOT_FOUND', 'Conversation not found.', 404);
    return updated;
  }

  async deleteConversation(userId: string, conversationId: string): Promise<void> {
    if (!(await this.repository.deleteConversation(userId, conversationId))) {
      throw new ChatError('CONVERSATION_NOT_FOUND', 'Conversation not found.', 404);
    }
  }

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    await this.assertModelAvailable(input.modelId);
    const content = input.content.trim();
    let conversation = await this.repository.findConversation(input.userId, input.conversationId);
    if (!conversation) {
      conversation = await this.createConversation({
        id: input.conversationId,
        userId: input.userId,
        title: content,
        modelId: input.modelId,
        responseLanguage: input.responseLanguage,
        project: input.project ?? null,
      });
    }

    let userMessage = await this.repository.findMessageByClientId(
      input.userId,
      input.conversationId,
      input.clientMessageId,
    );
    if (userMessage) {
      const existingReply = await this.repository.findReplyTo(input.userId, userMessage.id);
      if (existingReply) return { conversation, userMessage, assistantMessage: existingReply };
    } else {
      userMessage = await this.repository.appendMessage({
        id: randomUUID(),
        conversationId: input.conversationId,
        userId: input.userId,
        role: 'user',
        content,
        clientMessageId: input.clientMessageId,
        language: detectLanguage(content),
        createdAt: new Date(),
      });
    }

    const context = await this.repository.listMessages(
      input.userId,
      input.conversationId,
      this.maxContextMessages,
    );

    let generated: GenerateResult;
    try {
      const memory = await this.loadMemory?.(input.userId);
      generated = await this.aiRouter.generate({
        modelId: input.modelId,
        responseLanguage: input.responseLanguage,
        messages: context.map(({ role, content: messageContent }) => ({
          role,
          content: messageContent,
        })),
        ...(memory?.enabled
          ? {
              memory: {
                nickname: memory.nickname,
                occupation: memory.occupation,
                about: memory.about,
                summary: memory.summary,
              },
            }
          : {}),
      });
    } catch (error) {
      if (error instanceof ModelUnavailableError) {
        throw new ChatError(error.code, error.message, 503);
      }
      if (error instanceof ProviderRequestError) {
        throw new ChatError(error.code, error.message, 502);
      }
      throw error;
    }

    const now = new Date();
    const assistantMessage = await this.repository.appendMessage({
      id: randomUUID(),
      conversationId: input.conversationId,
      userId: input.userId,
      role: 'assistant',
      content: generated.content,
      replyToMessageId: userMessage.id,
      modelId: generated.modelId,
      provider: generated.provider,
      ...(generated.usage ? { usage: generated.usage } : {}),
      language: detectLanguage(generated.content),
      createdAt: now,
    });
    conversation =
      (await this.repository.updateConversation(input.userId, input.conversationId, {
        modelId: input.modelId,
        responseLanguage: input.responseLanguage,
        updatedAt: now,
      })) ?? conversation;

    return { conversation, userMessage, assistantMessage };
  }

  private async assertModelAvailable(modelId: ModelId): Promise<void> {
    const model = (await this.aiRouter.catalogue()).find((item) => item.id === modelId);
    if (!model?.available) {
      throw new ChatError('MODEL_UNAVAILABLE', `${modelId} is not configured on this server.`, 503);
    }
  }

  private async requireConversation(userId: string, conversationId: string) {
    const conversation = await this.repository.findConversation(userId, conversationId);
    if (!conversation) throw new ChatError('CONVERSATION_NOT_FOUND', 'Conversation not found.', 404);
    return conversation;
  }
}

function cleanTitle(title: string): string {
  const firstLine = title.trim().split('\n')[0]?.trim() || 'New chat';
  return firstLine.length > 80 ? `${firstLine.slice(0, 79).trimEnd()}\u2026` : firstLine;
}

function cleanProject(project: ConversationProject | null | undefined): ConversationProject | null {
  if (!project) return null;
  const id = project.id.trim();
  const name = project.name.trim();
  if (!id || !name) return null;
  return { id, name };
}

export function detectLanguage(content: string): 'en' | 'ar' | 'mixed' {
  const arabic = (content.match(/[\u0600-\u06ff]/g) ?? []).length;
  const latin = (content.match(/[a-z]/gi) ?? []).length;
  if (arabic && latin) return 'mixed';
  return arabic ? 'ar' : 'en';
}
