import { env } from '../../config/env.js';
import type { ModelId } from '../chat/chatRepository.js';
import {
  ModelUnavailableError,
  ProviderRequestError,
  type AiRouter,
  type GenerateInput,
  type GenerateResult,
  type ModelCatalogueItem,
} from './modelRouter.js';

type ModelsResponse = { models?: ModelCatalogueItem[] };
type CompletionResponse = {
  modelId?: ModelId;
  provider?: string;
  configuredModel?: string;
  choices?: Array<{ message?: { content?: string } }>;
  generatedImages?: Array<{ mimeType?: string; dataBase64?: string }>;
  usage?: GenerateResult['usage'];
};

export class AiServiceRouter implements AiRouter {
  private cachedModels: ModelCatalogueItem[] | null = null;
  private cacheExpiresAt = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = env.aiRequestTimeoutMs,
  ) {}

  async catalogue(): Promise<ModelCatalogueItem[]> {
    if (this.cachedModels && Date.now() < this.cacheExpiresAt) return this.cachedModels;
    const body = await this.request<ModelsResponse>('/chat/models', { method: 'GET' });
    const models = body.models ?? [];
    this.cachedModels = models;
    this.cacheExpiresAt = Date.now() + 15_000;
    return models;
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    const body = await this.request<CompletionResponse>('/chat/responses', {
      method: 'POST',
      body: JSON.stringify({
        modelId: input.modelId,
        messages: input.messages,
        responseLanguage: input.responseLanguage,
        ...(input.memory ? { memory: input.memory } : {}),
      }),
      signal: input.signal,
    }, input.modelId);
    const content = body.choices?.[0]?.message?.content?.trim() ?? '';
    const generatedImages = (body.generatedImages ?? []).flatMap((image) =>
      image.dataBase64
        ? [{ mimeType: image.mimeType || 'image/png', dataBase64: image.dataBase64 }]
        : [],
    );
    if (!content && !generatedImages.length) throw new ProviderRequestError(body.provider ?? 'AI service', 'The AI service returned an empty response.');
    return {
      content: content || 'Here is your generated image.',
      modelId: body.modelId ?? input.modelId,
      provider: body.provider ?? 'AI service',
      configuredModel: body.configuredModel ?? input.modelId,
      ...(body.usage ? { usage: body.usage } : {}),
      ...(generatedImages.length ? { generatedImages } : {}),
    };
  }

  private async request<T>(
    path: string,
    init: { method: 'GET' | 'POST'; body?: string; signal?: AbortSignal },
    modelId?: ModelId,
  ): Promise<T> {
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), this.timeoutMs);
    const signal = combineSignals(init.signal, timeoutController.signal);
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/+$/, '')}${path}`, {
        method: init.method,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        ...(init.body ? { body: init.body } : {}),
        signal,
      });
      const body = (await response.json().catch(() => ({}))) as T & {
        detail?: { code?: string; message?: string } | string;
      };
      if (!response.ok) {
        const detail = body.detail;
        const code = typeof detail === 'object' ? detail?.code : undefined;
        const message = typeof detail === 'object' ? detail?.message : detail;
        if ((response.status === 503 || code === 'MODEL_UNAVAILABLE') && modelId) {
          throw new ModelUnavailableError(modelId);
        }
        throw new ProviderRequestError('AI service', message || 'The AI service could not complete the request.');
      }
      return body;
    } catch (error) {
      if (error instanceof ModelUnavailableError || error instanceof ProviderRequestError) throw error;
      throw new ProviderRequestError('AI service', 'The AI service is not reachable.');
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createDefaultAiRouter(): AiRouter {
  return new AiServiceRouter(env.aiServiceBaseUrl);
}

function combineSignals(first: AbortSignal | undefined, second: AbortSignal): AbortSignal {
  if (!first) return second;
  if (first.aborted) return first;
  const controller = new AbortController();
  const abort = () => controller.abort();
  first.addEventListener('abort', abort, { once: true });
  second.addEventListener('abort', abort, { once: true });
  return controller.signal;
}
