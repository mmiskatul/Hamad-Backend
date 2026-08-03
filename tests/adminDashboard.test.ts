import assert from 'node:assert/strict';
import test from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { bootstrapAdminAccount } from '../src/modules/auth/adminBootstrap.js';
import { MemoryAuthRepository } from './helpers/memoryAuthRepository.js';

async function setupAdminApp(): Promise<{ app: FastifyInstance; accessToken: string; userId: string }> {
  const repository = new MemoryAuthRepository();
  await bootstrapAdminAccount(repository, {
    email: 'admin@example.com',
    password: 'a-long-admin-password',
    name: 'Platform Admin',
  });

  const app = buildApp({ authRepository: repository });
  await app.ready();

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/auth/login',
    payload: { email: 'admin@example.com', password: 'a-long-admin-password' },
  });
  assert.equal(login.statusCode, 200);
  const accessToken = login.json().accessToken as string;

  const users = await app.inject({
    method: 'GET',
    url: '/api/v1/admin/users',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(users.statusCode, 200);
  const userId = (users.json()[0] as { id: string }).id;
  assert.ok(userId, 'Should have at least one user fixture');

  return { app, accessToken, userId };
}

test('admin dashboard: suspend and reactivate user', async () => {
  const { app, accessToken, userId } = await setupAdminApp();

  const suspend = await app.inject({
    method: 'POST',
    url: `/api/v1/admin/users/${userId}/status`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { status: 'suspended', reason: 'Investigation underway' },
  });
  assert.equal(suspend.statusCode, 200);
  assert.equal(suspend.json().status, 'suspended');

  const reactivate = await app.inject({
    method: 'POST',
    url: `/api/v1/admin/users/${userId}/status`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { status: 'active', reason: 'Investigation resolved' },
  });
  assert.equal(reactivate.statusCode, 200);
  assert.equal(reactivate.json().status, 'active');

  const badReason = await app.inject({
    method: 'POST',
    url: `/api/v1/admin/users/${userId}/status`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { status: 'suspended', reason: 'too short' },
  });
  assert.equal(badReason.statusCode, 400);

  const unknown = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/users/usr_does_not_exist/status',
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { status: 'suspended', reason: 'Exceeds length requirement' },
  });
  assert.equal(unknown.statusCode, 404);

  await app.close();
});

test('admin dashboard: grant user quota records history and bumps limit', async () => {
  const { app, accessToken, userId } = await setupAdminApp();

  const before = await app.inject({
    method: 'GET',
    url: `/api/v1/admin/users/${userId}`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(before.statusCode, 200);
  const limitBefore = before.json().requestsLimit as number;

  const grant = await app.inject({
    method: 'POST',
    url: `/api/v1/admin/users/${userId}/quota-grant`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { amount: 250, reason: 'Compensation for outage' },
  });
  assert.equal(grant.statusCode, 200);
  const grantBody = grant.json();
  assert.equal(grantBody.entry.amount, 250);
  assert.equal(grantBody.user.requestsLimit, limitBefore + 250);

  const invalid = await app.inject({
    method: 'POST',
    url: `/api/v1/admin/users/${userId}/quota-grant`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { amount: 0, reason: 'Should fail' },
  });
  assert.equal(invalid.statusCode, 400);

  await app.close();
});

test('admin dashboard: set and reset quota override', async () => {
  const { app, accessToken, userId } = await setupAdminApp();

  const missingBypass = await app.inject({
    method: 'POST',
    url: `/api/v1/admin/users/${userId}/quota-override`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { reason: 'missing bypass flag' },
  });
  assert.equal(missingBypass.statusCode, 400);

  const set = await app.inject({
    method: 'POST',
    url: `/api/v1/admin/users/${userId}/quota-override`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {
      bypassQuota: true,
      customRequestsLimit: 99999,
      reason: 'Manual escalation due to Q4 launch',
    },
  });
  assert.equal(set.statusCode, 200);
  assert.equal(set.json().override.bypassQuota, true);

  const reset = await app.inject({
    method: 'DELETE',
    url: `/api/v1/admin/users/${userId}/quota-override`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { reason: 'Reset to tier default' },
  });
  assert.equal(reset.statusCode, 200);

  await app.close();
});

test('admin dashboard: unauthenticated callers are rejected', async () => {
  const { app } = await setupAdminApp();

  const noToken = await app.inject({
    method: 'GET',
    url: '/api/v1/admin/users',
  });
  assert.equal(noToken.statusCode, 401);

  await app.close();
});
