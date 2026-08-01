import { env } from '../../config/env.js';
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
};

export interface AiRouter {
  catalogue(): ModelCatalogueItem[];
  generate(input: GenerateInput): Promise<GenerateResult>;
}

type ProviderKind = 'openai-compatible' | 'anthropic' | 'gemini' | 'perplexity';
type ProviderConfig = {
  id: ModelId;
  name: string;
  provider: string;
  minPlan: ModelCatalogueItem['minPlan'];
  kind: ProviderKind;
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  model: string;
};

export class ModelUnavailableError extends Error {
  readonly code = 'MODEL_UNAVAILABLE';
  constructor(readonly modelId: ModelId) {
    super(`${modelId} is not configured on this server.`);
    this.name = 'ModelUnavailableError';
  }
}

export class ProviderRequestError extends Error {
  readonly code = 'PROVIDER_REQUEST_FAILED';
  constructor(readonly provider: string, message = 'The AI provider could not complete the request.') {
    super(message);
    this.name = 'ProviderRequestError';
  }
}

export class ConfiguredAiRouter implements AiRouter {
  constructor(
    private readonly providers: ProviderConfig[] = providerConfigs(),
    private readonly timeoutMs = env.aiRequestTimeoutMs,
  ) {}

  catalogue(): ModelCatalogueItem[] {
    return this.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      vendor: provider.provider,
      minPlan: provider.minPlan,
      available: provider.enabled && Boolean(provider.apiKey),
      configuredModel: provider.model,
    }));
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    const provider = this.providers.find((item) => item.id === input.modelId);
    if (!provider?.enabled || !provider.apiKey) throw new ModelUnavailableError(input.modelId);

    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), this.timeoutMs);
    const signal = combineSignals(input.signal, timeoutController.signal);
    try {
      const generated =
        provider.kind === 'anthropic'
          ? await requestAnthropic(provider, input, signal)
          : provider.kind === 'gemini'
            ? await requestGemini(provider, input, signal)
            : provider.kind === 'perplexity'
              ? await requestPerplexity(provider, input, signal)
            : await requestOpenAiCompatible(provider, input, signal);
      if (!generated.content.trim()) throw new ProviderRequestError(provider.provider, 'The AI provider returned an empty response.');
      return {
        content: generated.content.trim(),
        modelId: provider.id,
        provider: provider.provider,
        configuredModel: provider.model,
        ...(generated.usage ? { usage: generated.usage } : {}),
      };
    } catch (error) {
      if (error instanceof ModelUnavailableError || error instanceof ProviderRequestError) throw error;
      throw new ProviderRequestError(provider.provider);
    } finally {
      clearTimeout(timer);
    }
  }
}

function providerConfigs(): ProviderConfig[] {
  return [
    { id: 'gpt', name: 'ChatGPT', provider: 'OpenAI', minPlan: 'free', kind: 'openai-compatible', ...env.openAi },
    { id: 'deepseek', name: 'DeepSeek', provider: 'DeepSeek', minPlan: 'free', kind: 'openai-compatible', ...env.deepSeek },
    { id: 'gemini', name: 'Gemini', provider: 'Google', minPlan: 'pro', kind: 'gemini', ...env.gemini },
    { id: 'perplexity', name: 'Perplexity', provider: 'Perplexity', minPlan: 'pro', kind: 'perplexity', ...env.perplexity },
    { id: 'claude', name: 'Claude', provider: 'Anthropic', minPlan: 'business', kind: 'anthropic', ...env.anthropic },
    { id: 'grok', name: 'Grok', provider: 'xAI', minPlan: 'business', kind: 'openai-compatible', ...env.xAi },
  ];
}

function languageInstruction(language: ResponseLanguage): string {
  const instructions = {
    auto: "Reply in the language of the user's latest message.",
    en: 'Reply in English.',
    ar: 'Reply in Arabic.',
    both: 'Reply in English first, then provide the same answer in Arabic under an Arabic heading.',
  } as const;
  return `${instructions[language]} Preserve code, commands, URLs, API names, and identifiers exactly.`;
}

function normalizedMessages(input: GenerateInput) {
  return [
    { role: 'system' as const, content: systemInstruction(input) },
    ...input.messages,
  ];
}

function systemInstruction(input: GenerateInput): string {
  const base = `You are OneAI Hub, a helpful assistant. ${languageInstruction(input.responseLanguage)}`;
  if (!input.memory) return base;
  const details = [
    input.memory.nickname && `Preferred name: ${input.memory.nickname}`,
    input.memory.occupation && `Occupation: ${input.memory.occupation}`,
    input.memory.about && `About the user: ${input.memory.about}`,
    input.memory.summary && `Saved memory: ${input.memory.summary}`,
  ].filter(Boolean).join('\n');
  return details ? `${base}\nUse the following user memory only when relevant:\n${details}` : base;
}

async function requestOpenAiCompatible(
  provider: ProviderConfig,
  input: GenerateInput,
  signal: AbortSignal,
): Promise<ProviderGeneration> {
  const response = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: provider.model, messages: normalizedMessages(input) }),
    signal,
  });
  const body = (await response.json().catch(() => ({}))) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    error?: { message?: string };
  };
  if (!response.ok) throw new ProviderRequestError(provider.provider, body.error?.message);
  return {
    content: body.choices?.[0]?.message?.content ?? '',
    usage: openAiUsage(body.usage),
  };
}

async function requestPerplexity(
  provider: ProviderConfig,
  input: GenerateInput,
  signal: AbortSignal,
): Promise<ProviderGeneration> {
  const response = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/v1/sonar`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: provider.model, messages: normalizedMessages(input) }),
    signal,
  });
  const body = (await response.json().catch(() => ({}))) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    error?: { message?: string };
  };
  if (!response.ok) throw new ProviderRequestError(provider.provider, body.error?.message);
  return {
    content: body.choices?.[0]?.message?.content ?? '',
    usage: openAiUsage(body.usage),
  };
}

async function requestAnthropic(
  provider: ProviderConfig,
  input: GenerateInput,
  signal: AbortSignal,
): Promise<ProviderGeneration> {
  const response = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: provider.model,
      max_tokens: 4096,
      system: systemInstruction(input),
      messages: input.messages,
    }),
    signal,
  });
  const body = (await response.json().catch(() => ({}))) as {
    content?: { type?: string; text?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: { message?: string };
  };
  if (!response.ok) throw new ProviderRequestError(provider.provider, body.error?.message);
  const inputTokens = body.usage?.input_tokens ?? 0;
  const outputTokens = body.usage?.output_tokens ?? 0;
  return {
    content: body.content?.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('') ?? '',
    usage: body.usage ? { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } : undefined,
  };
}

async function requestGemini(
  provider: ProviderConfig,
  input: GenerateInput,
  signal: AbortSignal,
): Promise<ProviderGeneration> {
  const model = encodeURIComponent(provider.model);
  const key = encodeURIComponent(provider.apiKey);
  const response = await fetch(
    `${provider.baseUrl.replace(/\/$/, '')}/models/${model}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemInstruction(input) }],
        },
        contents: input.messages.map((message) => ({
          role: message.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: message.content }],
        })),
      }),
      signal,
    },
  );
  const body = (await response.json().catch(() => ({}))) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
    };
    error?: { message?: string };
  };
  if (!response.ok) throw new ProviderRequestError(provider.provider, body.error?.message);
  const inputTokens = body.usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = body.usageMetadata?.candidatesTokenCount ?? 0;
  return {
    content: body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '',
    usage: body.usageMetadata
      ? { inputTokens, outputTokens, totalTokens: body.usageMetadata.totalTokenCount ?? inputTokens + outputTokens }
      : undefined,
  };
}

type ProviderGeneration = {
  content: string;
  usage?: GenerateResult['usage'];
};

function openAiUsage(usage?: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}): GenerateResult['usage'] | undefined {
  if (!usage) return undefined;
  const inputTokens = usage.prompt_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;
  return { inputTokens, outputTokens, totalTokens: usage.total_tokens ?? inputTokens + outputTokens };
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
