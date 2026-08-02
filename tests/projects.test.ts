import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { SessionService } from '../src/modules/auth/sessionService.js';
import { MemoryAuthRepository } from './helpers/memoryAuthRepository.js';
import { MemoryProjectRepository } from './helpers/memoryProjectRepository.js';

async function createAuthedApp() {
  const authRepository = new MemoryAuthRepository();
  const projectRepository = new MemoryProjectRepository();
  const user = await authRepository.createUser({
    email: 'projects@example.com',
    name: 'Project User',
    passwordHash: 'unused',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
  });
  const credentials = await new SessionService(authRepository, env.jwtSecret, env.sessionExpiresDays).create(user, {});
  const app = buildApp({ authRepository, projectRepository });
  await app.ready();
  const accessToken = app.jwt.sign({
    sub: user.id,
    sid: credentials.session.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt.toISOString(),
  });
  return { app, accessToken };
}

test('projects routes create, list, update, source-manage, and delete projects', async () => {
  const { app, accessToken } = await createAuthedApp();
  const headers = { authorization: `Bearer ${accessToken}` };

  try {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers,
      payload: { name: 'Client Portal', scope: 'project-only', instructions: 'Be concise.' },
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().name, 'Client Portal');
    assert.equal(created.json().scope, 'project-only');
    assert.equal(created.json().pinned, false);
    const projectId = created.json().id;

    const listed = await app.inject({ method: 'GET', url: '/api/v1/projects', headers });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.equal(listed.json().projects.length, 1);
    assert.equal(listed.json().projects[0].id, projectId);

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}`,
      headers,
      payload: { pinned: true, description: 'Internal workspace' },
    });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(updated.json().pinned, true);
    assert.equal(updated.json().description, 'Internal workspace');

    const sourced = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/sources`,
      headers,
      payload: { name: 'brief.md', uri: 'https://example.com/brief.md' },
    });
    assert.equal(sourced.statusCode, 200, sourced.body);
    assert.equal(sourced.json().sources.length, 1);
    assert.equal(sourced.json().sources[0].name, 'brief.md');
    const sourceId = sourced.json().sources[0].id;

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${projectId}/sources/${sourceId}`,
      headers,
    });
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal(removed.json().sources.length, 0);

    const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/projects/${projectId}`, headers });
    assert.equal(deleted.statusCode, 204, deleted.body);

    const afterDelete = await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}`, headers });
    assert.equal(afterDelete.statusCode, 404, afterDelete.body);
  } finally {
    await app.close();
  }
});
