import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import { MemoryAuthRepository } from './helpers/memoryAuthRepository.js';
import { MemoryEmailSender } from './helpers/memoryEmailSender.js';

test('registration verifies the emailed code and stores a hashed password', async () => {
  const repository = new MemoryAuthRepository();
  const emailSender = new MemoryEmailSender();
  const app = buildApp({ authRepository: repository, emailSender });
  const email = 'New.Person@Example.com';

  const checkBefore = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/check-email',
    payload: { email },
  });
  assert.equal(checkBefore.statusCode, 200);
  assert.deepEqual(checkBefore.json(), {
    email: 'new.person@example.com',
    registered: false,
  });

  const requested = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/registration/request-code',
    payload: { email },
  });
  assert.equal(requested.statusCode, 202);
  assert.deepEqual(Object.keys(requested.json()).sort(), [
    'email',
    'expiresInSeconds',
    'sent',
  ]);
  assert.equal(emailSender.messages.length, 1);
  assert.equal(emailSender.messages[0]?.to, 'new.person@example.com');
  const code = emailSender.messages[0]?.code;
  assert.match(code ?? '', /^\d{4}$/);

  const verified = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/registration/verify-code',
    payload: { email, code },
  });
  assert.equal(verified.statusCode, 200);
  const { verificationToken } = verified.json() as { verificationToken: string };
  assert.ok(verificationToken.length >= 20);

  const replayedCode = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/registration/verify-code',
    payload: { email, code },
  });
  assert.equal(replayedCode.statusCode, 400);
  assert.equal(replayedCode.json().error.code, 'INVALID_OR_EXPIRED_CODE');

  const registered = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/registration',
    payload: {
      email,
      name: ' Sam Rivera ',
      password: 'sup3rsecret',
      verificationToken,
    },
  });
  assert.equal(registered.statusCode, 201);
  const body = registered.json();
  assert.deepEqual(body.user, {
    id: '1',
    email: 'new.person@example.com',
    name: 'Sam Rivera',
    createdAt: body.user.createdAt,
  });
  assert.equal('passwordHash' in body.user, false);
  assert.equal(body.tokenType, 'Bearer');
  assert.equal(body.expiresIn, '15m');
  assert.equal(typeof body.accessToken, 'string');
  assert.match(body.refreshToken, /^rt_/);
  assert.match(body.sessionToken, /^st_/);
  const sessionLifetimeDays =
    (Date.parse(body.sessionExpiresAt) - Date.now()) / (24 * 60 * 60 * 1000);
  assert.ok(sessionLifetimeDays > 29.99 && sessionLifetimeDays <= 30);

  const storedSession = [...repository.sessions.values()][0];
  assert.ok(storedSession);
  assert.notEqual(storedSession.refreshTokenHash, body.refreshToken);
  assert.notEqual(storedSession.sessionTokenHash, body.sessionToken);

  const stored = repository.users.get('new.person@example.com');
  assert.ok(stored?.passwordHash.startsWith('scrypt$'));
  assert.notEqual(stored?.passwordHash, 'sup3rsecret');
  assert.equal(repository.verifications.has('new.person@example.com'), false);

  const checkAfter = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/check-email',
    payload: { email },
  });
  assert.equal(checkAfter.json().registered, true);

  const unauthenticatedProfile = await app.inject({
    method: 'GET',
    url: '/api/v1/auth/me',
  });
  assert.equal(unauthenticatedProfile.statusCode, 401);

  const profile = await app.inject({
    method: 'GET',
    url: '/api/v1/auth/me',
    headers: { authorization: `Bearer ${body.accessToken}` },
  });
  assert.equal(profile.statusCode, 200);
  assert.deepEqual(profile.json().user, body.user);

  await app.close();
});

test('registration rejects a bad code and an unverified registration', async () => {
  const repository = new MemoryAuthRepository();
  const app = buildApp({
    authRepository: repository,
    emailSender: new MemoryEmailSender(),
  });
  const email = 'new.person@example.com';

  await app.inject({
    method: 'POST',
    url: '/api/v1/auth/registration/request-code',
    payload: { email },
  });

  const badCode = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/registration/verify-code',
    payload: { email, code: '9999' },
  });
  assert.equal(badCode.statusCode, 400);
  assert.equal(badCode.json().error.code, 'INVALID_OR_EXPIRED_CODE');

  const unverified = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/registration',
    payload: {
      email,
      name: 'Sam Rivera',
      password: 'sup3rsecret',
      verificationToken: 'not-a-valid-registration-token',
    },
  });
  assert.equal(unverified.statusCode, 400);
  assert.equal(unverified.json().error.code, 'INVALID_REGISTRATION_TOKEN');

  await app.close();
});

test('login creates a session and refresh rotates tokens until logout or replay', async () => {
  const repository = new MemoryAuthRepository();
  const emailSender = new MemoryEmailSender();
  const app = buildApp({ authRepository: repository, emailSender });
  const email = 'member@example.com';

  await app.inject({
    method: 'POST',
    url: '/api/v1/auth/registration/request-code',
    payload: { email },
  });
  const verified = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/registration/verify-code',
    payload: { email, code: emailSender.messages[0]?.code },
  });
  await app.inject({
    method: 'POST',
    url: '/api/v1/auth/registration',
    payload: {
      email,
      name: 'Member',
      password: 'correct-horse-battery-staple',
      verificationToken: verified.json().verificationToken,
    },
  });

  const rejected = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: 'wrong-password' },
  });
  assert.equal(rejected.statusCode, 401);
  assert.equal(rejected.json().error.code, 'INVALID_CREDENTIALS');

  const loggedIn = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: 'MEMBER@example.com', password: 'correct-horse-battery-staple' },
  });
  assert.equal(loggedIn.statusCode, 200);
  assert.equal(loggedIn.json().user.email, email);
  assert.equal(loggedIn.json().tokenType, 'Bearer');
  assert.equal(typeof loggedIn.json().accessToken, 'string');
  assert.match(loggedIn.json().refreshToken, /^rt_/);
  assert.match(loggedIn.json().sessionToken, /^st_/);

  const listed = await app.inject({
    method: 'GET',
    url: '/api/v1/auth/sessions',
    headers: { authorization: `Bearer ${loggedIn.json().accessToken}` },
  });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().sessions.length, 2);
  const current = listed.json().sessions.find(
    (session: { current: boolean }) => session.current,
  );
  assert.ok(current);

  const registrationSession = listed.json().sessions.find(
    (session: { current: boolean }) => !session.current,
  );
  const revokedOtherSession = await app.inject({
    method: 'DELETE',
    url: `/api/v1/auth/sessions/${registrationSession.id}`,
    headers: { authorization: `Bearer ${loggedIn.json().accessToken}` },
  });
  assert.equal(revokedOtherSession.statusCode, 204);

  const originalRefreshToken = loggedIn.json().refreshToken;
  const originalSessionToken = loggedIn.json().sessionToken;
  const expiredAccessToken = app.jwt.sign(
    {
      sub: '1',
      sid: current.id,
      email,
      name: 'Member',
      createdAt: repository.users.get(email)?.createdAt.toISOString(),
    },
    { expiresIn: -1 },
  );
  const rejectedExpiredAccess = await app.inject({
    method: 'GET',
    url: '/api/v1/auth/me',
    headers: { authorization: `Bearer ${expiredAccessToken}` },
  });
  assert.equal(rejectedExpiredAccess.statusCode, 401);

  const refreshed = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/refresh',
    payload: {
      refreshToken: originalRefreshToken,
      sessionToken: originalSessionToken,
    },
  });
  assert.equal(refreshed.statusCode, 200);
  assert.notEqual(refreshed.json().accessToken, loggedIn.json().accessToken);
  assert.notEqual(refreshed.json().refreshToken, originalRefreshToken);
  assert.equal(refreshed.json().sessionToken, originalSessionToken);
  assert.equal(refreshed.json().sessionExpiresAt, loggedIn.json().sessionExpiresAt);

  const replayed = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/refresh',
    payload: {
      refreshToken: originalRefreshToken,
      sessionToken: originalSessionToken,
    },
  });
  assert.equal(replayed.statusCode, 401);
  assert.equal(replayed.json().error.code, 'INVALID_SESSION');

  const invalidatedAfterReplay = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/refresh',
    payload: {
      refreshToken: refreshed.json().refreshToken,
      sessionToken: originalSessionToken,
    },
  });
  assert.equal(invalidatedAfterReplay.statusCode, 401);

  const loggedInAgain = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: 'correct-horse-battery-staple' },
  });
  const loggedOut = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/logout',
    payload: { sessionToken: loggedInAgain.json().sessionToken },
  });
  assert.equal(loggedOut.statusCode, 204);

  const refreshAfterLogout = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/refresh',
    payload: {
      refreshToken: loggedInAgain.json().refreshToken,
      sessionToken: loggedInAgain.json().sessionToken,
    },
  });
  assert.equal(refreshAfterLogout.statusCode, 401);

  await app.close();
});
