import type {
  ChatRepository,
  ConversationRecord,
  CreateConversationInput,
  MessageRecord,
  UsageSnapshot,
} from '../../src/modules/chat/chatRepository.js';

export class MemoryChatRepository implements ChatRepository {
  readonly conversations = new Map<string, ConversationRecord>();
  readonly messages: MessageRecord[] = [];

  async ensureIndexes(): Promise<void> {}

  async createConversation(input: CreateConversationInput): Promise<ConversationRecord> {
    if (this.conversations.has(input.id)) throw new Error('Duplicate conversation');
    this.conversations.set(input.id, input);
    return input;
  }

  async findConversation(userId: string, conversationId: string): Promise<ConversationRecord | null> {
    const record = this.conversations.get(conversationId);
    return record?.userId === userId ? record : null;
  }

  async listConversations(userId: string): Promise<ConversationRecord[]> {
    return [...this.conversations.values()]
      .filter((item) => item.userId === userId)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  async updateConversation(
    userId: string,
    conversationId: string,
    patch: Partial<Pick<ConversationRecord, 'title' | 'modelId' | 'responseLanguage' | 'updatedAt'>>,
  ): Promise<ConversationRecord | null> {
    const record = await this.findConversation(userId, conversationId);
    if (!record) return null;
    const updated = { ...record, ...patch };
    this.conversations.set(conversationId, updated);
    return updated;
  }

  async deleteConversation(userId: string, conversationId: string): Promise<boolean> {
    const record = await this.findConversation(userId, conversationId);
    if (!record) return false;
    this.conversations.delete(conversationId);
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      if (this.messages[index]?.conversationId === conversationId) this.messages.splice(index, 1);
    }
    return true;
  }

  async appendMessage(message: MessageRecord): Promise<MessageRecord> {
    this.messages.push(message);
    return message;
  }

  async findMessageByClientId(
    userId: string,
    conversationId: string,
    clientMessageId: string,
  ): Promise<MessageRecord | null> {
    return this.messages.find((item) =>
      item.userId === userId &&
      item.conversationId === conversationId &&
      item.clientMessageId === clientMessageId
    ) ?? null;
  }

  async findReplyTo(userId: string, messageId: string): Promise<MessageRecord | null> {
    return this.messages.find((item) => item.userId === userId && item.replyToMessageId === messageId) ?? null;
  }

  async listMessages(userId: string, conversationId: string, limit = 100): Promise<MessageRecord[]> {
    return this.messages
      .filter((item) => item.userId === userId && item.conversationId === conversationId)
      .slice(-limit);
  }

  async aggregateUsage(userId: string, since: Date): Promise<UsageSnapshot> {
    const messages = this.messages.filter(
      (message) => message.userId === userId && message.role === 'assistant' && message.createdAt >= since,
    );
    const byModel: UsageSnapshot['byModel'] = {};
    for (const message of messages) {
      if (!message.modelId) continue;
      const current = byModel[message.modelId] ?? { requests: 0, tokens: 0 };
      byModel[message.modelId] = {
        requests: current.requests + 1,
        tokens: current.tokens + (message.usage?.totalTokens ?? 0),
      };
    }
    return {
      requests: messages.length,
      tokens: messages.reduce((total, message) => total + (message.usage?.totalTokens ?? 0), 0),
      byModel,
    };
  }
}
