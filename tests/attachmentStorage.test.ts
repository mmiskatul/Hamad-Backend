import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AttachmentStorage,
  type CloudinaryGateway,
} from '../src/modules/chat/attachmentStorage.js';

test('Cloudinary attachment storage saves, lists, reads, and removes an owned file', async () => {
  const assets = new Map<string, { data: Buffer; context: Record<string, string> }>();
  const gateway: CloudinaryGateway = {
    async upload(input) {
      const publicId = `${input.publicId}.asset`;
      assets.set(publicId, { data: input.data, context: input.context });
      return { publicId, context: input.context };
    },
    async list(prefix) {
      return [...assets.entries()]
        .filter(([publicId]) => publicId.startsWith(prefix))
        .map(([publicId, asset]) => ({ publicId, context: asset.context }));
    },
    async download(publicId) {
      const asset = assets.get(publicId);
      if (!asset) throw new Error('missing test asset');
      return asset.data;
    },
    async remove(publicId) {
      return assets.delete(publicId);
    },
  };
  const storage = new AttachmentStorage({ folder: 'test/chat', gateway });

  const saved = await storage.save('user:1', 'conversation/1', {
    name: '../photo.jpg',
    mimeType: 'image/jpeg',
    data: Buffer.from('image bytes'),
  });

  assert.equal(saved.name, 'photo.jpg');
  assert.equal(saved.size, 11);
  assert.deepEqual((await storage.list('user:1', 'conversation/1')).map((item) => item.id), [saved.id]);
  assert.equal((await storage.read('user:1', 'conversation/1', saved.id))?.data.toString(), 'image bytes');
  assert.equal(await storage.read('another-user', 'conversation/1', saved.id), null);
  assert.equal(await storage.remove('user:1', 'conversation/1', saved.id), true);
  assert.equal(await storage.read('user:1', 'conversation/1', saved.id), null);
  assert.equal(assets.size, 0);
});

test('deleting a conversation removes all of its Cloudinary assets only', async () => {
  const assets = new Map<string, { data: Buffer; context: Record<string, string> }>();
  const gateway: CloudinaryGateway = {
    async upload(input) {
      const publicId = `${input.publicId}.asset`;
      assets.set(publicId, { data: input.data, context: input.context });
      return { publicId, context: input.context };
    },
    async list(prefix) {
      return [...assets.entries()]
        .filter(([publicId]) => publicId.startsWith(prefix))
        .map(([publicId, asset]) => ({ publicId, context: asset.context }));
    },
    async download(publicId) {
      return assets.get(publicId)?.data ?? Buffer.alloc(0);
    },
    async remove(publicId) {
      return assets.delete(publicId);
    },
  };
  const storage = new AttachmentStorage({ gateway });
  await storage.save('user-1', 'chat-1', { name: 'one.pdf', mimeType: 'application/pdf', data: Buffer.from('1') });
  await storage.save('user-1', 'chat-2', { name: 'two.pdf', mimeType: 'application/pdf', data: Buffer.from('2') });

  await storage.removeConversation('user-1', 'chat-1');

  assert.equal(assets.size, 1);
  assert.equal((await storage.list('user-1', 'chat-2')).length, 1);
});
