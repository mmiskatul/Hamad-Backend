import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import type {
  AiRouter,
  GenerateInput,
  GenerateResult,
  ModelCatalogueItem,
} from '../src/modules/ai/modelRouter.js';
import { SessionService } from '../src/modules/auth/sessionService.js';
import { env } from '../src/config/env.js';
import { MemoryAuthRepository } from './helpers/memoryAuthRepository.js';

class RecordingAiRouter implements AiRouter {
  readonly calls: GenerateInput[] = [];

  catalogue(): ModelCatalogueItem[] {
    return [
      {
        id: 'gpt',
        name: 'ChatGPT',
        vendor: 'OpenAI',
        minPlan: 'free',
        available: true,
        configuredModel: 'test-gpt',
      },
      {
        id: 'gemini',
        name: 'Gemini',
        vendor: 'Google',
        minPlan: 'pro',
        available: true,
        configuredModel: 'test-gemini',
      },
    ];
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    this.calls.push(input);
    return {
      content: input.modelId === 'gemini' ? 'Gemini answer' : 'GPT answer',
      modelId: input.modelId,
      provider: input.modelId === 'gemini' ? 'Google' : 'OpenAI',
      configuredModel: `test-${input.modelId}`,
      usage: { inputTokens: 12, outputTokens: 34, totalTokens: 46 },
    };
  }
}

async function createAuthedApp(router = new RecordingAiRouter()) {
  const authRepository = new MemoryAuthRepository();
  const user = await authRepository.createUser({
    email: 'ai@example.com',
    name: 'AI User',
    passwordHash: 'unused',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    memory: {
      enabled: true,
      nickname: 'Miskat',
      occupation: 'Engineer',
      about: 'Prefers concise answers.',
      summary: 'Concise, direct responses only.',
      summaryUpdatedAt: new Date('2026-08-01T00:00:00.000Z'),
    },
  });
  const credentials = await new SessionService(
    authRepository,
    env.jwtSecret,
    env.sessionExpiresDays,
  ).create(user, {});
  const app = buildApp({ authRepository, aiRouter: router });
  await app.ready();
  const accessToken = app.jwt.sign({
    sub: user.id,
    sid: credentials.session.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt.toISOString(),
  });
  return { app, accessToken, router };
}

test('ai gateway exposes the configured model catalogue', async () => {
  const { app, accessToken } = await createAuthedApp();

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/ai/models',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().models, [
      {
        id: 'gpt',
        name: 'ChatGPT',
        vendor: 'OpenAI',
        minPlan: 'free',
        available: true,
        configuredModel: 'test-gpt',
      },
      {
        id: 'gemini',
        name: 'Gemini',
        vendor: 'Google',
        minPlan: 'pro',
        available: true,
        configuredModel: 'test-gemini',
      },
    ]);
  } finally {
    await app.close();
  }
});

test('ai chat completions returns a chatgpt-style envelope and uses memory', async () => {
  const { app, accessToken, router } = await createAuthedApp();

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/chat/completions',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        modelId: 'gpt',
        messages: [{ role: 'user', content: 'Summarize the plan' }],
        responseLanguage: 'en',
      },
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().object, 'chat.completion');
    assert.equal(response.json().modelId, 'gpt');
    assert.equal(response.json().provider, 'OpenAI');
    assert.equal(response.json().choices[0].message.content, 'GPT answer');
    assert.equal(router.calls[0]?.responseLanguage, 'en');
    assert.equal(router.calls[0]?.memory?.nickname, 'Miskat');
    assert.deepEqual(router.calls[0]?.messages, [{ role: 'user', content: 'Summarize the plan' }]);
  } finally {
    await app.close();
  }
});

test('ai responses accepts a prompt shorthand', async () => {
  const { app, accessToken, router } = await createAuthedApp();

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/responses',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        modelId: 'gemini',
        prompt: 'Explain the architecture',
        responseLanguage: 'ar',
      },
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().object, 'response');
    assert.equal(response.json().modelId, 'gemini');
    assert.equal(response.json().provider, 'Google');
    assert.equal(response.json().content, 'Gemini answer');
    assert.equal(router.calls[0]?.responseLanguage, 'ar');
    assert.deepEqual(router.calls[0]?.messages, [{ role: 'user', content: 'Explain the architecture' }]);
  } finally {
    await app.close();
  }
});
