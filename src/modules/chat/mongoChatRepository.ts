import type { Collection, Db } from 'mongodb';
import type {
  ChatRepository,
  ConversationRecord,
  CreateConversationInput,
  MessageRecord,
  UpdateConversationPatch,
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
    this.indexesReady ??= this.prepareIndexes();
    return this.indexesReady;
  }

  private async prepareIndexes(): Promise<void> {
    await Promise.all([
      this.conversations.createIndex({ userId: 1, pinned: -1, pinnedAt: -1, updatedAt: -1 }),
      this.messages.createIndex({ conversationId: 1, createdAt: 1 }),
      this.messages.createIndex({ replyToMessageId: 1 }, { sparse: true }),
    ]);

    const indexName = 'conversationId_1_clientMessageId_1';
    const existing = (await this.messages.listIndexes().toArray())
      .find((index) => index.name === indexName);

    // A sparse compound index still includes every message because
    // `conversationId` is always present. MongoDB therefore indexes assistant
    // messages with clientMessageId=null and rejects the second assistant reply.
    // Migrate that old index before creating the correctly filtered one.
    if (existing && !existing.partialFilterExpression) {
      await this.messages.dropIndex(indexName);
    }

    await this.messages.createIndex(
      { conversationId: 1, clientMessageId: 1 },
      {
        name: indexName,
        unique: true,
        partialFilterExpression: { clientMessageId: { $type: 'string' } },
      },
    );
  }

  async createConversation(input: CreateConversationInput): Promise<ConversationRecord> {
    await this.ensureIndexes();
    await this.conversations.insertOne({ _id: input.id, ...input });
    return input;
  }

  async findConversation(userId: string, conversationId: string): Promise<ConversationRecord | null> {
    const record = await this.conversations.findOne({ _id: conversationId, userId });
    return record ? withoutMongoId(record) : null;
  }

  async listConversations(userId: string): Promise<ConversationRecord[]> {
    const records = await this.conversations
      .find({ userId })
      .sort({ pinned: -1, pinnedAt: -1, updatedAt: -1 })
      .toArray();
    return records.map(withoutMongoId);
  }

  async updateConversation(
    userId: string,
    conversationId: string,
    patch: UpdateConversationPatch,
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
    // Ownership was proven by deleting the user's conversation above. Delete
    // every associated message, including records from older builds that did
    // not persist userId consistently.
    await this.messages.deleteMany({ conversationId });
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
      if (row._id) {
        byModel[row._id as keyof typeof byModel] = { requests: row.requests, tokens: row.tokens };
      }
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
