import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import type {
  AiRouter,
  GenerateInput,
  GenerateResult,
  ModelCatalogueItem,
} from '../src/modules/ai/modelRouter.js';
import { ChatService } from '../src/modules/chat/chatService.js';
import { SessionService } from '../src/modules/auth/sessionService.js';
import { env } from '../src/config/env.js';
import { MemoryAuthRepository } from './helpers/memoryAuthRepository.js';
import { MemoryChatRepository } from './helpers/memoryChatRepository.js';

class RecordingAiRouter implements AiRouter {
  readonly calls: GenerateInput[] = [];
  constructor(private readonly available = true) {}

  catalogue(): ModelCatalogueItem[] {
    return [
      { id: 'gpt', name: 'ChatGPT', vendor: 'OpenAI', minPlan: 'free', available: this.available, configuredModel: 'test-gpt' },
      { id: 'deepseek', name: 'DeepSeek', vendor: 'DeepSeek', minPlan: 'free', available: this.available, configuredModel: 'test-deepseek' },
    ];
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    this.calls.push(input);
    return {
      content: input.modelId === 'deepseek'
        ? '\u0625\u062c\u0627\u0628\u0629 \u062f\u064a\u0628 \u0633\u064a\u0643'
        : 'GPT answer',
      modelId: input.modelId,
      provider: input.modelId === 'deepseek' ? 'DeepSeek' : 'OpenAI',
      configuredModel: `test-${input.modelId}`,
    };
  }
}

test('one conversation keeps shared history while switching models and language', async () => {
  const repository = new MemoryChatRepository();
  const router = new RecordingAiRouter();
  const service = new ChatService(repository, router, 30);
  const arabicPrompt = '\u0645\u0627 \u0627\u0633\u0645 \u0645\u0634\u0631\u0648\u0639\u064a\u061f';

  await service.sendMessage({
    userId: 'user-1', conversationId: 'conversation-1', clientMessageId: 'message-1',
    content: 'Remember that my project is OneAI.', modelId: 'gpt', responseLanguage: 'en',
  });
  const second = await service.sendMessage({
    userId: 'user-1', conversationId: 'conversation-1', clientMessageId: 'message-2',
    content: arabicPrompt, modelId: 'deepseek', responseLanguage: 'ar',
  });

  assert.equal(router.calls.length, 2);
  assert.deepEqual(router.calls[1]?.messages.map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'Remember that my project is OneAI.' },
    { role: 'assistant', content: 'GPT answer' },
    { role: 'user', content: arabicPrompt },
  ]);
  assert.equal(router.calls[1]?.modelId, 'deepseek');
  assert.equal(router.calls[1]?.responseLanguage, 'ar');
  assert.equal(second.assistantMessage.provider, 'DeepSeek');
  assert.equal(second.assistantMessage.language, 'ar');
  assert.equal(second.conversation.modelId, 'deepseek');
});

test('client message id makes a completed send idempotent', async () => {
  const repository = new MemoryChatRepository();
  const router = new RecordingAiRouter();
  const service = new ChatService(repository, router, 30);
  const input = {
    userId: 'user-1', conversationId: 'conversation-1', clientMessageId: 'stable-id',
    content: 'Hello', modelId: 'gpt' as const, responseLanguage: 'auto' as const,
  };

  const first = await service.sendMessage(input);
  const retry = await service.sendMessage(input);

  assert.equal(router.calls.length, 1);
  assert.equal(retry.assistantMessage.id, first.assistantMessage.id);
  assert.equal(repository.messages.length, 2);
});

test('chat routes reject unauthenticated calls and accept an active JWT session', async () => {
  const authRepository = new MemoryAuthRepository();
  const chatRepository = new MemoryChatRepository();
  const router = new RecordingAiRouter();
  const user = await authRepository.createUser({
    email: 'chat@example.com', name: 'Chat User', passwordHash: 'unused', createdAt: new Date(),
  });
  const credentials = await new SessionService(
    authRepository,
    env.jwtSecret,
    env.sessionExpiresDays,
  ).create(user, {});
  const app = buildApp({ authRepository, chatRepository, aiRouter: router });
  await app.ready();

  const unauthenticated = await app.inject({ method: 'GET', url: '/api/v1/models' });
  assert.equal(unauthenticated.statusCode, 401);

  const accessToken = app.jwt.sign({
    sub: user.id,
    sid: credentials.session.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt.toISOString(),
  });
  const sendResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/conversations/mobile-conversation/messages',
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {
      clientMessageId: 'mobile-message',
      content: 'Hello from Mobile',
      modelId: 'gpt',
      responseLanguage: 'en',
      project: { id: 'project-1', name: 'Mobile project' },
    },
  });

  assert.equal(sendResponse.statusCode, 201, sendResponse.body);
  assert.equal(sendResponse.json().assistantMessage.content, 'GPT answer');
  assert.equal(chatRepository.messages.length, 2);

  const pinResponse = await app.inject({
    method: 'PATCH',
    url: '/api/v1/conversations/mobile-conversation',
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { pinned: true },
  });
  assert.equal(pinResponse.statusCode, 200, pinResponse.body);
  assert.equal(pinResponse.json().pinned, true);
  assert.ok(pinResponse.json().pinnedAt);

  const listResponse = await app.inject({
    method: 'GET',
    url: '/api/v1/conversations',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(listResponse.statusCode, 200, listResponse.body);
  assert.deepEqual(listResponse.json().conversations[0]?.project, { id: 'project-1', name: 'Mobile project' });
  assert.equal(listResponse.json().conversations[0]?.pinned, true);

  const detailResponse = await app.inject({
    method: 'GET',
    url: '/api/v1/conversations/mobile-conversation',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(detailResponse.statusCode, 200, detailResponse.body);
  assert.equal(detailResponse.json().messages.length, 2);
  assert.equal(detailResponse.json().messages[0]?.clientMessageId, 'mobile-message');

  const deleteResponse = await app.inject({
    method: 'DELETE',
    url: '/api/v1/conversations/mobile-conversation',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(deleteResponse.statusCode, 204, deleteResponse.body);
  assert.equal(chatRepository.conversations.size, 0);
  assert.equal(chatRepository.messages.length, 0);

  const deletedDetailResponse = await app.inject({
    method: 'GET',
    url: '/api/v1/conversations/mobile-conversation',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(deletedDetailResponse.statusCode, 404, deletedDetailResponse.body);

  await app.close();
});

test('unconfigured models return a clear service-unavailable error', async () => {
  const service = new ChatService(new MemoryChatRepository(), new RecordingAiRouter(false), 30);
  await assert.rejects(
    service.sendMessage({
      userId: 'user-1', conversationId: 'conversation-1', clientMessageId: 'message-1',
      content: 'Hello', modelId: 'gpt', responseLanguage: 'auto',
    }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'MODEL_UNAVAILABLE',
  );
});
