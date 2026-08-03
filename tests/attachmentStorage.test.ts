import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AttachmentStorage } from '../src/modules/chat/attachmentStorage.js';

test('attachment storage saves, lists, reads, and removes an owned file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oneai-attachments-'));
  const storage = new AttachmentStorage(directory);
  try {
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
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
