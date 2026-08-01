import type { Db, Collection } from 'mongodb';
import type {
  ChatRepository,
  ConversationRecord,
  CreateConversationInput,
  MessageRecord,
  UsageSnapshot,
} from './chatRepository.js';

export class MongoChatRepository implements ChatRepository {
  private readonly conversations: Collection<ConversationRecord & { _id: string }>;
  private readonly messages: Collection<MessageRecord & { _id: string }>;
  private indexesReady: Promise<void> | null = null;

  constructor(db: Db) {
    this.conversations = db.collection('chat_conversations');
    this.messages = db.collection('chat_messages');
  }

  ensureIndexes(): Promise<void> {
    this.indexesReady ??= Promise.all([
      this.conversations.createIndex({ userId: 1, updatedAt: -1 }),
      this.messages.createIndex({ conversationId: 1, createdAt: 1 }),
      this.messages.createIndex(
        { conversationId: 1, clientMessageId: 1 },
        { unique: true, sparse: true },
      ),
      this.messages.createIndex({ replyToMessageId: 1 }, { sparse: true }),
    ]).then(() => undefined);
    return this.indexesReady;
  }

  async createConversation(input: CreateConversationInput): Promise<ConversationRecord> {
    await this.ensureIndexes();
    const record = { _id: input.id, ...input };
    await this.conversations.insertOne(record);
    return input;
  }

  async findConversation(userId: string, conversationId: string): Promise<ConversationRecord | null> {
    const record = await this.conversations.findOne({ _id: conversationId, userId });
    return record ? withoutMongoId(record) : null;
  }

  async listConversations(userId: string): Promise<ConversationRecord[]> {
    const records = await this.conversations.find({ userId }).sort({ updatedAt: -1 }).toArray();
    return records.map(withoutMongoId);
  }

  async updateConversation(
    userId: string,
    conversationId: string,
    patch: Partial<Pick<ConversationRecord, 'title' | 'modelId' | 'responseLanguage' | 'updatedAt'>>,
  ): Promise<ConversationRecord | null> {
    const result = await this.conversations.findOneAndUpdate(
      { _id: conversationId, userId },
      { $set: patch },
      { returnDocument: 'after' },
    );
    return result ? withoutMongoId(result) : null;
  }

  async deleteConversation(userId: string, conversationId: string): Promise<boolean> {
    const result = await this.conversations.deleteOne({ _id: conversationId, userId });
    if (!result.deletedCount) return false;
    await this.messages.deleteMany({ conversationId, userId });
    return true;
  }

  async appendMessage(message: MessageRecord): Promise<MessageRecord> {
    await this.ensureIndexes();
    await this.messages.insertOne({ _id: message.id, ...message });
    return message;
  }

  async findMessageByClientId(
    userId: string,
    conversationId: string,
    clientMessageId: string,
  ): Promise<MessageRecord | null> {
    const record = await this.messages.findOne({ userId, conversationId, clientMessageId });
    return record ? withoutMongoId(record) : null;
  }

  async findReplyTo(userId: string, messageId: string): Promise<MessageRecord | null> {
    const record = await this.messages.findOne({ userId, replyToMessageId: messageId });
    return record ? withoutMongoId(record) : null;
  }

  async listMessages(
    userId: string,
    conversationId: string,
    limit = 100,
  ): Promise<MessageRecord[]> {
    const records = await this.messages
      .find({ userId, conversationId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    return records.reverse().map(withoutMongoId);
  }

  async aggregateUsage(userId: string, since: Date): Promise<UsageSnapshot> {
    const rows = await this.messages.aggregate<{ _id: string; requests: number; tokens: number }>([
      { $match: { userId, role: 'assistant', createdAt: { $gte: since } } },
      {
        $group: {
          _id: '$modelId',
          requests: { $sum: 1 },
          tokens: { $sum: { $ifNull: ['$usage.totalTokens', 0] } },
        },
      },
    ]).toArray();
    const byModel: UsageSnapshot['byModel'] = {};
    let requests = 0;
    let tokens = 0;
    for (const row of rows) {
      if (row._id) byModel[row._id as keyof typeof byModel] = { requests: row.requests, tokens: row.tokens };
      requests += row.requests;
      tokens += row.tokens;
    }
    return { requests, tokens, byModel };
  }
}

function withoutMongoId<T extends { _id: string }>(record: T): Omit<T, '_id'> {
  const { _id: _ignored, ...rest } = record;
  return rest;
}
