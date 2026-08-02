import assert from 'node:assert/strict';
import test from 'node:test';
import type { Db, IndexDescription, IndexDescriptionInfo } from 'mongodb';
import { MongoChatRepository } from '../src/modules/chat/mongoChatRepository.js';

test('Mongo chat idempotency index excludes assistant messages without a client id', async () => {
  const created: Array<{ keys: IndexDescription; options?: Record<string, unknown> }> = [];
  const dropped: string[] = [];
  const conversationCollection = {
    createIndex: async () => 'conversation-index',
  };
  const messageCollection = {
    createIndex: async (keys: IndexDescription, options?: Record<string, unknown>) => {
      created.push({ keys, options });
      return options?.name as string ?? 'generated-index';
    },
    listIndexes: () => ({
      toArray: async (): Promise<IndexDescriptionInfo[]> => [{
        name: 'conversationId_1_clientMessageId_1',
        key: { conversationId: 1, clientMessageId: 1 },
        sparse: true,
        unique: true,
        v: 2,
      }],
    }),
    dropIndex: async (name: string) => {
      dropped.push(name);
      return { ok: 1 };
    },
  };
  const db = {
    collection: (name: string) => name === 'chat_conversations'
      ? conversationCollection
      : messageCollection,
  } as unknown as Db;

  await new MongoChatRepository(db).ensureIndexes();

  assert.deepEqual(dropped, ['conversationId_1_clientMessageId_1']);
  const idempotencyIndex = created.find(
    ({ options }) => options?.name === 'conversationId_1_clientMessageId_1',
  );
  assert.deepEqual(idempotencyIndex?.options, {
    name: 'conversationId_1_clientMessageId_1',
    unique: true,
    partialFilterExpression: { clientMessageId: { $type: 'string' } },
  });
});
