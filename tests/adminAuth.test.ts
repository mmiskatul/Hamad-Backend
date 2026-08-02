import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import { bootstrapAdminAccount } from '../src/modules/auth/adminBootstrap.js';
import { hashPassword } from '../src/modules/auth/authService.js';
import { MemoryAuthRepository } from './helpers/memoryAuthRepository.js';

test('admin bootstrap creates one hashed admin account and is idempotent', async () => {
  const repository = new MemoryAuthRepository();
  const input = {
    email: 'ADMIN@example.com',
    password: 'a-long-admin-password',
    name: 'Platform Admin',
  };

  const first = await bootstrapAdminAccount(repository, input);
  const second = await bootstrapAdminAccount(repository, input);

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.user.id, second.user.id);
  assert.equal(first.user.email, 'admin@example.com');
  assert.equal(first.user.role, 'admin');
  assert.equal(first.user.plan, 'business');
  assert.notEqual(first.user.passwordHash, input.password);
  assert.match(first.user.passwordHash, /^scrypt\$/);
  assert.equal(repository.users.size, 1);
});

test('admin auth creates, refreshes, validates, and revokes a database session', async () => {
  const repository = new MemoryAuthRepository();
  await bootstrapAdminAccount(repository, {
    email: 'admin@example.com',
    password: 'a-long-admin-password',
    name: 'Platform Admin',
  });
  await repository.createUser({
    email: 'member@example.com',
    name: 'Member',
    passwordHash: await hashPassword('member-password'),
    createdAt: new Date(),
    role: 'user',
    plan: 'free',
  });

  const app = buildApp({ authRepository: repository });
  await app.ready();

  const denied = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/auth/login',
    payload: { email: 'member@example.com', password: 'member-password' },
  });
  assert.equal(denied.statusCode, 403);

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/auth/login',
    headers: { 'user-agent': 'admin-dashboard-test' },
    payload: { email: 'admin@example.com', password: 'a-long-admin-password' },
  });
  assert.equal(login.statusCode, 200);
  const credentials = login.json();
  assert.equal(credentials.user.role, 'admin');
  assert.match(credentials.accessToken, /^[^.]+\.[^.]+\.[^.]+$/);
  assert.match(credentials.refreshToken, /^rt_/);
  assert.match(credentials.sessionToken, /^st_/);
  assert.equal(repository.sessions.size, 1);

  const me = await app.inject({
    method: 'GET',
    url: '/api/v1/admin/auth/me',
    headers: { authorization: `Bearer ${credentials.accessToken}` },
  });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().user.email, 'admin@example.com');

  const listed = await app.inject({
    method: 'GET',
    url: '/api/v1/admin/auth/sessions',
    headers: { authorization: `Bearer ${credentials.accessToken}` },
  });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().sessions.length, 1);
  assert.equal(listed.json().sessions[0].current, true);

  const revokeOthers = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/auth/sessions/revoke-others',
    headers: { authorization: `Bearer ${credentials.accessToken}` },
  });
  assert.equal(revokeOthers.statusCode, 200);
  assert.equal(revokeOthers.json().revoked, 0);

  const refreshed = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/auth/refresh',
    payload: {
      refreshToken: credentials.refreshToken,
      sessionToken: credentials.sessionToken,
    },
  });
  assert.equal(refreshed.statusCode, 200);
  assert.notEqual(refreshed.json().refreshToken, credentials.refreshToken);
  assert.equal(refreshed.json().sessionToken, credentials.sessionToken);

  const logout = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/auth/logout',
    payload: { sessionToken: credentials.sessionToken },
  });
  assert.equal(logout.statusCode, 204);

  const refreshAfterLogout = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/auth/refresh',
    payload: {
      refreshToken: refreshed.json().refreshToken,
      sessionToken: credentials.sessionToken,
    },
  });
  assert.equal(refreshAfterLogout.statusCode, 401);

  await app.close();
});
