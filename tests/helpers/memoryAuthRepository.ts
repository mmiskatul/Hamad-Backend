import {
  DuplicateEmailError,
  type AuthRepository,
  type NewSession,
  type NewUser,
  type SessionRecord,
  type UserRecord,
  type VerificationRecord,
} from '../../src/modules/auth/authRepository.js';

export class MemoryAuthRepository implements AuthRepository {
  readonly users = new Map<string, UserRecord>();
  readonly verifications = new Map<string, VerificationRecord>();
  readonly sessions = new Map<string, SessionRecord>();
  private nextId = 1;
  private nextSessionId = 1;

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    return this.users.get(email) ?? null;
  }

  async saveVerification(input: {
    email: string;
    codeHash: string;
    expiresAt: Date;
  }): Promise<void> {
    this.verifications.set(input.email, { ...input, attempts: 0 });
  }

  async findVerification(email: string): Promise<VerificationRecord | null> {
    return this.verifications.get(email) ?? null;
  }

  async incrementVerificationAttempts(email: string): Promise<void> {
    const record = this.verifications.get(email);
    if (record) record.attempts += 1;
  }

  async markVerificationComplete(input: {
    email: string;
    verificationTokenHash: string;
    expiresAt: Date;
    verifiedAt: Date;
  }): Promise<void> {
    const record = this.verifications.get(input.email);
    if (!record) return;
    record.codeHash = undefined;
    record.verificationTokenHash = input.verificationTokenHash;
    record.verifiedAt = input.verifiedAt;
    record.expiresAt = input.expiresAt;
  }

  async createUser(user: NewUser): Promise<UserRecord> {
    if (this.users.has(user.email)) throw new DuplicateEmailError();
    const saved = { ...user, id: String(this.nextId++) };
    this.users.set(user.email, saved);
    return saved;
  }

  async deleteVerification(email: string): Promise<void> {
    this.verifications.delete(email);
  }

  async createSession(session: NewSession): Promise<SessionRecord> {
    const saved = { ...session, id: String(this.nextSessionId++) };
    this.sessions.set(saved.id, saved);
    return saved;
  }

  async findSessionByTokenHash(sessionTokenHash: string): Promise<SessionRecord | null> {
    return (
      [...this.sessions.values()].find(
        (session) => session.sessionTokenHash === sessionTokenHash,
      ) ?? null
    );
  }

  async rotateSessionRefreshToken(input: {
    id: string;
    currentRefreshTokenHash: string;
    nextRefreshTokenHash: string;
    lastUsedAt: Date;
  }): Promise<boolean> {
    const session = this.sessions.get(input.id);
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt.getTime() <= input.lastUsedAt.getTime() ||
      session.refreshTokenHash !== input.currentRefreshTokenHash
    ) {
      return false;
    }
    session.refreshTokenHash = input.nextRefreshTokenHash;
    session.lastUsedAt = input.lastUsedAt;
    return true;
  }

  async revokeSessionByTokenHash(sessionTokenHash: string, revokedAt: Date): Promise<void> {
    const session = await this.findSessionByTokenHash(sessionTokenHash);
    if (session && !session.revokedAt) session.revokedAt = revokedAt;
  }

  async findActiveSessionsByUserId(userId: string, now: Date): Promise<SessionRecord[]> {
    return [...this.sessions.values()]
      .filter(
        (session) =>
          session.userId === userId &&
          !session.revokedAt &&
          session.expiresAt.getTime() > now.getTime(),
      )
      .sort((left, right) => right.lastUsedAt.getTime() - left.lastUsedAt.getTime());
  }

  async revokeSessionById(input: {
    id: string;
    userId: string;
    revokedAt: Date;
  }): Promise<boolean> {
    const session = this.sessions.get(input.id);
    if (!session || session.userId !== input.userId || session.revokedAt) return false;
    session.revokedAt = input.revokedAt;
    return true;
  }
}
