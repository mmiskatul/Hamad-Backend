import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import { MemoryAuthRepository } from './helpers/memoryAuthRepository.js';

test('health endpoint reports the service as healthy', async () => {
  const app = buildApp({ authRepository: new MemoryAuthRepository() });
  const response = await app.inject({ method: 'GET', url: '/api/v1/health' });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    status: 'ok',
    service: 'hamad-backend',
  });

  await app.close();
});
