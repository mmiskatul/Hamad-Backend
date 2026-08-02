export const MODEL_IDS = ['gpt', 'deepseek', 'gemini', 'perplexity', 'claude', 'grok'] as const;
export type ModelId = (typeof MODEL_IDS)[number];

export const RESPONSE_LANGUAGES = ['auto', 'en', 'ar', 'both'] as const;
export type ResponseLanguage = (typeof RESPONSE_LANGUAGES)[number];

export type ChatRole = 'user' | 'assistant';

export type ConversationProject = {
  id: string;
  name: string;
};

export type ConversationRecord = {
  id: string;
  userId: string;
  title: string;
  modelId: ModelId;
  responseLanguage: ResponseLanguage;
  pinned: boolean;
  pinnedAt: Date | null;
  project: ConversationProject | null;
  createdAt: Date;
  updatedAt: Date;
};

export type MessageRecord = {
  id: string;
  conversationId: string;
  userId: string;
  role: ChatRole;
  content: string;
  clientMessageId?: string;
  replyToMessageId?: string;
  modelId?: ModelId;
  provider?: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  language: 'en' | 'ar' | 'mixed';
  createdAt: Date;
};

export type UsageSnapshot = {
  requests: number;
  tokens: number;
  byModel: Partial<Record<ModelId, { requests: number; tokens: number }>>;
};

export type CreateConversationInput = Omit<ConversationRecord, 'createdAt' | 'updatedAt'> & {
  createdAt: Date;
  updatedAt: Date;
};

export type UpdateConversationPatch = Partial<
  Pick<ConversationRecord, 'title' | 'modelId' | 'responseLanguage' | 'pinned' | 'updatedAt'>
> & {
  pinnedAt?: Date | null;
};

export interface ChatRepository {
  ensureIndexes(): Promise<void>;
  createConversation(input: CreateConversationInput): Promise<ConversationRecord>;
  findConversation(userId: string, conversationId: string): Promise<ConversationRecord | null>;
  listConversations(userId: string): Promise<ConversationRecord[]>;
  updateConversation(
    userId: string,
    conversationId: string,
    patch: UpdateConversationPatch,
  ): Promise<ConversationRecord | null>;
  deleteConversation(userId: string, conversationId: string): Promise<boolean>;
  appendMessage(message: MessageRecord): Promise<MessageRecord>;
  findMessageByClientId(
    userId: string,
    conversationId: string,
    clientMessageId: string,
  ): Promise<MessageRecord | null>;
  findReplyTo(userId: string, messageId: string): Promise<MessageRecord | null>;
  listMessages(userId: string, conversationId: string, limit?: number): Promise<MessageRecord[]>;
  aggregateUsage(userId: string, since: Date): Promise<UsageSnapshot>;
}