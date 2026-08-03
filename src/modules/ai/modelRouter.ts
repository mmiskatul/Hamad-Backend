import type { MessageRecord, ModelId, ResponseLanguage } from '../chat/chatRepository.js';

export type ModelCatalogueItem = {
  id: ModelId;
  name: string;
  vendor: string;
  minPlan: 'free' | 'pro' | 'business';
  available: boolean;
  configuredModel: string;
};

export type GenerateInput = {
  modelId: ModelId;
  messages: Pick<MessageRecord, 'role' | 'content'>[];
  responseLanguage: ResponseLanguage;
  memory?: { nickname: string; occupation: string; about: string; summary: string };
  signal?: AbortSignal;
};

export type GenerateResult = {
  content: string;
  modelId: ModelId;
  provider: string;
  configuredModel: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  generatedImages?: Array<{ mimeType: string; dataBase64: string }>;
};

export interface AiRouter {
  catalogue(): ModelCatalogueItem[] | Promise<ModelCatalogueItem[]>;
  generate(input: GenerateInput): Promise<GenerateResult>;
}

export class ModelUnavailableError extends Error {
  readonly code = 'MODEL_UNAVAILABLE';

  constructor(readonly modelId: ModelId) {
    super(`${modelId} is not configured in the AI service.`);
    this.name = 'ModelUnavailableError';
  }
}

export class ProviderRequestError extends Error {
  readonly code = 'PROVIDER_REQUEST_FAILED';

  constructor(
    readonly provider: string,
    message = 'The AI service could not complete the request.',
  ) {
    super(message);
    this.name = 'ProviderRequestError';
  }
}
