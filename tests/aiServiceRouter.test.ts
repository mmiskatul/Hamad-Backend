import assert from 'node:assert/strict';
import test from 'node:test';
import { AiServiceRouter } from '../src/modules/ai/aiServiceRouter.js';

test('ai service router loads models and generates through FastAPI', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body?: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (url.endsWith('/chat/models')) {
      return Response.json({
        models: [{
          id: 'gpt', name: 'ChatGPT', vendor: 'OpenAI', minPlan: 'free',
          available: true, configuredModel: 'gpt-test',
        }],
      });
    }
    return Response.json({
      modelId: 'gpt',
      provider: 'OpenAI',
      configuredModel: 'gpt-test',
      choices: [{ message: { role: 'assistant', content: 'AI agent answer' } }],
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    });
  };

  try {
    const router = new AiServiceRouter('http://127.0.0.1:8000/api/v1');
    const models = await router.catalogue();
    const result = await router.generate({
      modelId: 'gpt',
      messages: [{ role: 'user', content: 'Hello' }],
      responseLanguage: 'en',
      memory: { nickname: 'Miskat', occupation: '', about: '', summary: '' },
    });

    assert.equal(models[0]?.available, true);
    assert.equal(result.content, 'AI agent answer');
    assert.equal(result.usage?.totalTokens, 5);
    assert.equal(requests[0]?.url, 'http://127.0.0.1:8000/api/v1/chat/models');
    assert.deepEqual(requests[1]?.body, {
      modelId: 'gpt',
      messages: [{ role: 'user', content: 'Hello' }],
      responseLanguage: 'en',
      memory: { nickname: 'Miskat', occupation: '', about: '', summary: '' },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
