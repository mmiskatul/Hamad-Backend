import { randomUUID } from 'node:crypto';
import type { MessageRecord, ModelId, ResponseLanguage } from '../chat/chatRepository.js';
import type { AiRouter, GenerateResult, ModelCatalogueItem } from './modelRouter.js';

export type AiGatewayMessage = Pick<MessageRecord, 'role' | 'content'>;

export type AiGatewayMemory = {
  enabled: boolean;
  nickname: string;
  occupation: string;
  about: string;
  summary: string;
};

export type AiGatewayInput = {
  userId?: string;
  modelId: ModelId;
  messages: AiGatewayMessage[];
  responseLanguage: ResponseLanguage;
};

export type AiGatewayResponse = {
  id: string;
  object: 'response';
  createdAt: string;
  modelId: ModelId;
  provider: string;
  configuredModel: string;
  content: string;
  usage?: GenerateResult['usage'];
};

export type AiChatCompletion = {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  modelId: ModelId;
  provider: string;
  configuredModel: string;
  choices: Array<{
    index: number;
    message: { role: 'assistant'; content: string };
    finish_reason: 'stop';
  }>;
  usage?: GenerateResult['usage'];
};

export class AiGatewayService {
  constructor(
    private readonly aiRouter: AiRouter,
    private readonly loadMemory?: (userId: string) => Promise<AiGatewayMemory | null>,
  ) {}

  async catalogue(): Promise<ModelCatalogueItem[]> {
    return await this.aiRouter.catalogue();
  }

  normalizeMessages(prompt?: string, messages?: AiGatewayMessage[]): AiGatewayMessage[] {
    if (messages?.length) return messages;
    const trimmed = prompt?.trim();
    if (!trimmed) return [];
    return [{ role: 'user', content: trimmed }];
  }

  async generate(input: AiGatewayInput): Promise<GenerateResult> {
    const memory = input.userId && this.loadMemory ? await this.loadMemory(input.userId) : null;
    return this.aiRouter.generate({
      modelId: input.modelId,
      messages: input.messages,
      responseLanguage: input.responseLanguage,
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
  }

  toResponse(result: GenerateResult): AiGatewayResponse {
    return {
      id: `resp_${randomUUID()}`,
      object: 'response',
      createdAt: new Date().toISOString(),
      modelId: result.modelId,
      provider: result.provider,
      configuredModel: result.configuredModel,
      content: result.content,
      ...(result.usage ? { usage: result.usage } : {}),
    };
  }

  toChatCompletion(result: GenerateResult): AiChatCompletion {
    return {
      id: `chatcmpl_${randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: result.configuredModel,
      modelId: result.modelId,
      provider: result.provider,
      configuredModel: result.configuredModel,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: result.content },
          finish_reason: 'stop',
        },
      ],
      ...(result.usage ? { usage: result.usage } : {}),
    };
  }
}
