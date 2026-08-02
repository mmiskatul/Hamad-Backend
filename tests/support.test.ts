import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { SessionService } from '../src/modules/auth/sessionService.js';
import { MemoryAuthRepository } from './helpers/memoryAuthRepository.js';
import { MemorySupportRepository } from './helpers/memorySupportRepository.js';

test('support tickets require auth and persist the submitted message', async () => {
  const authRepository = new MemoryAuthRepository();
  const supportRepository = new MemorySupportRepository();
  const user = await authRepository.createUser({
    email: 'support@example.com',
    name: 'Support User',
    passwordHash: 'unused',
    createdAt: new Date(),
  });
  const credentials = await new SessionService(
    authRepository,
    env.jwtSecret,
    env.sessionExpiresDays,
  ).create(user, {});
  const app = buildApp({ authRepository, supportRepository });
  await app.ready();

  const unauthenticated = await app.inject({
    method: 'POST',
    url: '/api/v1/support/tickets',
    payload: { subject: 'Billing', message: 'My invoice is wrong.' },
  });
  assert.equal(unauthenticated.statusCode, 401);

  const accessToken = app.jwt.sign({
    sub: user.id,
    sid: credentials.session.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt.toISOString(),
  });
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/support/tickets',
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { subject: 'Billing', message: 'My invoice is wrong.' },
  });

  assert.equal(response.statusCode, 201, response.body);
  assert.equal(supportRepository.tickets.length, 1);
  assert.equal(supportRepository.tickets[0]?.subject, 'Billing');
  assert.equal(supportRepository.tickets[0]?.message, 'My invoice is wrong.');
  assert.equal(supportRepository.tickets[0]?.email, user.email);
  assert.equal(response.json().ticket.status, 'open');

  await app.close();
});