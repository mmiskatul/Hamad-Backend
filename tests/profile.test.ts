import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { SessionService } from '../src/modules/auth/sessionService.js';
import { MemoryAuthRepository } from './helpers/memoryAuthRepository.js';
import { MemoryChatRepository } from './helpers/memoryChatRepository.js';

test('profile endpoints read and update authenticated account data', async () => {
  const repository = new MemoryAuthRepository();
  const user = await repository.createUser({
    email: 'profile@example.com',
    name: 'Original Name',
    passwordHash: 'unused',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
  });
  await repository.createUser({
    email: 'taken@example.com',
    name: 'Another User',
    passwordHash: 'unused',
    createdAt: new Date(),
  });
  const sessionService = new SessionService(repository, env.jwtSecret, env.sessionExpiresDays);
  const credentials = await sessionService.create(user, {});
  const app = buildApp({
    authRepository: repository,
    chatRepository: new MemoryChatRepository(),
  });
  await app.ready();
  const token = app.jwt.sign({
    sub: user.id,
    sid: credentials.session.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt.toISOString(),
  });
  const headers = { authorization: `Bearer ${token}` };

  const initial = await app.inject({ method: 'GET', url: '/api/v1/profile', headers });
  assert.equal(initial.statusCode, 200, initial.body);
  assert.deepEqual(initial.json(), {
    id: user.id,
    name: 'Original Name',
    email: 'profile@example.com',
    phone: '',
    avatarUri: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  });

  const updated = await app.inject({
    method: 'PATCH',
    url: '/api/v1/profile',
    headers,
    payload: {
      name: '  Updated Name  ',
      email: 'UPDATED@EXAMPLE.COM',
      phone: ' +880 1700 000 000 ',
    },
  });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(updated.json().name, 'Updated Name');
  assert.equal(updated.json().email, 'updated@example.com');
  assert.equal(updated.json().phone, '+880 1700 000 000');

  // Updating the session's email link is required so refresh keeps working.
  const refreshed = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/refresh',
    payload: {
      refreshToken: credentials.refreshToken,
      sessionToken: credentials.sessionToken,
    },
  });
  assert.equal(refreshed.statusCode, 200, refreshed.body);
  assert.equal(refreshed.json().user.email, 'updated@example.com');

  const duplicate = await app.inject({
    method: 'PATCH',
    url: '/api/v1/profile',
    headers,
    payload: { email: 'taken@example.com' },
  });
  assert.equal(duplicate.statusCode, 409);
  assert.equal(duplicate.json().error.code, 'EMAIL_ALREADY_REGISTERED');

  await app.close();
});

test('profile endpoints require an active session', async () => {
  const app = buildApp({
    authRepository: new MemoryAuthRepository(),
    chatRepository: new MemoryChatRepository(),
  });
  const response = await app.inject({ method: 'GET', url: '/api/v1/profile' });
  assert.equal(response.statusCode, 401);
  await app.close();
});
