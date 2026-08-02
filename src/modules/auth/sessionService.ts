import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type {
  AuthRepository,
  SessionRecord,
  UserRecord,
} from './authRepository.js';

const TOKEN_BYTES = 48;

export type SessionClient = {
  userAgent?: string;
  ipAddress?: string;
};

export type SessionCredentials = {
  user: UserRecord;
  session: SessionRecord;
  refreshToken: string;
  sessionToken: string;
};

export type SessionErrorCode = 'INVALID_SESSION' | 'SESSION_NOT_FOUND';

export class SessionError extends Error {
  constructor(
    readonly code: SessionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SessionError';
  }
}

export class SessionService {
  constructor(
    private readonly repository: AuthRepository,
    private readonly secret: string,
    private readonly expiresDays: number,
  ) {}

  async create(user: UserRecord, client: SessionClient): Promise<SessionCredentials> {
    const refreshToken = opaqueToken('rt');
    const sessionToken = opaqueToken('st');
    const createdAt = new Date();
    const session = await this.repository.createSession({
      userId: user.id,
      userEmail: user.email,
      refreshTokenHash: this.hashToken(refreshToken),
      sessionTokenHash: this.hashToken(sessionToken),
      createdAt,
      lastUsedAt: createdAt,
      expiresAt: new Date(createdAt.getTime() + this.expiresDays * 24 * 60 * 60 * 1000),
      userAgent: cleanMetadata(client.userAgent, 512),
      ipAddress: cleanMetadata(client.ipAddress, 64),
    });
    return { user, session, refreshToken, sessionToken };
  }

  async refresh(refreshToken: string, sessionToken: string): Promise<SessionCredentials> {
    const sessionTokenHash = this.hashToken(sessionToken);
    const session = await this.repository.findSessionByTokenHash(sessionTokenHash);
    const now = new Date();

    if (!session || session.revokedAt || session.expiresAt.getTime() <= now.getTime()) {
      throw invalidSession();
    }

    const presentedRefreshHash = this.hashToken(refreshToken);
    if (!safeEqual(session.refreshTokenHash, presentedRefreshHash)) {
      await this.repository.revokeSessionByTokenHash(sessionTokenHash, now);
      throw invalidSession();
    }

    const user = await this.repository.findUserByEmail(session.userEmail);
    if (!user || user.id !== session.userId) {
      await this.repository.revokeSessionByTokenHash(sessionTokenHash, now);
      throw invalidSession();
    }

    const nextRefreshToken = opaqueToken('rt');
    const rotated = await this.repository.rotateSessionRefreshToken({
      id: session.id,
      currentRefreshTokenHash: presentedRefreshHash,
      nextRefreshTokenHash: this.hashToken(nextRefreshToken),
      lastUsedAt: now,
    });
    if (!rotated) {
      await this.repository.revokeSessionByTokenHash(sessionTokenHash, now);
      throw invalidSession();
    }

    return {
      user,
      session: {
        ...session,
        refreshTokenHash: this.hashToken(nextRefreshToken),
        lastUsedAt: now,
      },
      refreshToken: nextRefreshToken,
      sessionToken,
    };
  }

  async logout(sessionToken: string): Promise<void> {
    await this.repository.revokeSessionByTokenHash(
      this.hashToken(sessionToken),
      new Date(),
    );
  }

  async assertActive(userId: string, sessionId: string): Promise<void> {
    const session = await this.repository.findActiveSessionById({
      id: sessionId,
      userId,
      now: new Date(),
    });
    if (!session) throw invalidSession();
  }

  async list(userId: string): Promise<SessionRecord[]> {
    return this.repository.findActiveSessionsByUserId(userId, new Date());
  }

  async revoke(userId: string, sessionId: string): Promise<void> {
    const revoked = await this.repository.revokeSessionById({
      id: sessionId,
      userId,
      revokedAt: new Date(),
    });
    if (!revoked) {
      throw new SessionError('SESSION_NOT_FOUND', 'The session was not found.');
    }
  }

  async revokeOthers(userId: string, currentSessionId: string): Promise<number> {
    const active = await this.list(userId);
    const others = active.filter((session) => session.id !== currentSessionId);
    await Promise.all(others.map((session) => this.revoke(userId, session.id)));
    return others.length;
  }

  private hashToken(token: string): string {
    return createHmac('sha256', this.secret).update(token).digest('hex');
  }
}

function opaqueToken(prefix: 'rt' | 'st'): string {
  return `${prefix}_${randomBytes(TOKEN_BYTES).toString('base64url')}`;
}

function cleanMetadata(value: string | undefined, maxLength: number): string | undefined {
  const clean = value?.trim();
  return clean ? clean.slice(0, maxLength) : undefined;
}

function invalidSession(): SessionError {
  return new SessionError(
    'INVALID_SESSION',
    'The session is invalid, expired, or has been revoked. Please log in again.',
  );
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
