import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { SessionService } from '../src/modules/auth/sessionService.js';
import { MemoryAuthRepository } from './helpers/memoryAuthRepository.js';
import { MemoryChatRepository } from './helpers/memoryChatRepository.js';

test('settings, memory, usage, and about endpoints return account data', async () => {
  const authRepository = new MemoryAuthRepository();
  const chatRepository = new MemoryChatRepository();
  const user = await authRepository.createUser({
    email: 'settings@example.com',
    name: 'Settings User',
    passwordHash: 'unused',
    createdAt: new Date(),
  });
  const credentials = await new SessionService(
    authRepository,
    env.jwtSecret,
    env.sessionExpiresDays,
  ).create(user, {});
  await chatRepository.appendMessage({
    id: 'assistant-1',
    conversationId: 'conversation-1',
    userId: user.id,
    role: 'assistant',
    content: 'Hello',
    modelId: 'gpt',
    provider: 'OpenAI',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    language: 'en',
    createdAt: new Date(),
  });

  const app = buildApp({ authRepository, chatRepository });
  await app.ready();
  const token = app.jwt.sign({ sub: user.id, sid: credentials.session.id });
  const headers = { authorization: `Bearer ${token}` };

  const memory = await app.inject({
    method: 'PATCH', url: '/api/v1/settings/memory', headers,
    payload: { enabled: true, nickname: 'Miskat', occupation: 'Engineer' },
  });
  assert.equal(memory.statusCode, 200, memory.body);
  assert.equal(memory.json().enabled, true);
  assert.equal(memory.json().nickname, 'Miskat');

  const summary = await app.inject({
    method: 'POST', url: '/api/v1/settings/memory/summary', headers,
    payload: { text: 'Prefers concise answers.' },
  });
  assert.equal(summary.statusCode, 200, summary.body);
  assert.equal(summary.json().summary, 'Prefers concise answers.');

  const usage = await app.inject({ method: 'GET', url: '/api/v1/usage', headers });
  assert.equal(usage.statusCode, 200, usage.body);
  assert.equal(usage.json().requests, 1);
  assert.equal(usage.json().tokens, 15);
  assert.deepEqual(usage.json().byModel.gpt, { requests: 1, tokens: 15 });

  for (const [plan, requests, tokens] of [
    ['pro', 500, 4000],
    ['business', 5000, 8000],
    ['free', 50, 1000],
  ] as const) {
    const changed = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings/plan',
      headers,
      payload: { plan },
    });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.deepEqual(changed.json(), { plan, limits: { requests, tokens } });
  }

  const invalidPlan = await app.inject({
    method: 'PATCH',
    url: '/api/v1/settings/plan',
    headers,
    payload: { plan: 'enterprise' },
  });
  assert.equal(invalidPlan.statusCode, 400);

  const about = await app.inject({ method: 'GET', url: '/api/v1/about' });
  assert.equal(about.statusCode, 200, about.body);
  assert.equal(about.json().name, 'OneAI Hub');

  await app.close();
});
