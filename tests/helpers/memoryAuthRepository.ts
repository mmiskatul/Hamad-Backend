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

  async findUserById(id: string): Promise<UserRecord | null> {
    return [...this.users.values()].find((user) => user.id === id) ?? null;
  }

  async saveVerification(input: {
    email: string;
    purpose: VerificationRecord['purpose'];
    codeHash: string;
    expiresAt: Date;
  }): Promise<void> {
    this.verifications.set(input.email, { ...input, attempts: 0 });
  }

  async findVerification(
    email: string,
    purpose: VerificationRecord['purpose'],
  ): Promise<VerificationRecord | null> {
    const verification = this.verifications.get(email);
    return verification?.purpose === purpose ? verification : null;
  }

  async incrementVerificationAttempts(
    email: string,
    purpose: VerificationRecord['purpose'],
  ): Promise<void> {
    const record = this.verifications.get(email);
    if (record?.purpose === purpose) record.attempts += 1;
  }

  async markVerificationComplete(input: {
    email: string;
    purpose: VerificationRecord['purpose'];
    verificationTokenHash: string;
    expiresAt: Date;
    verifiedAt: Date;
  }): Promise<void> {
    const record = this.verifications.get(input.email);
    if (!record || record.purpose !== input.purpose) return;
    record.codeHash = undefined;
    record.verificationTokenHash = input.verificationTokenHash;
    record.verifiedAt = input.verifiedAt;
    record.expiresAt = input.expiresAt;
  }

  async createUser(user: NewUser): Promise<UserRecord> {
    if (this.users.has(user.email)) throw new DuplicateEmailError();
    const saved = { ...user, id: String(this.nextId++), plan: user.plan ?? 'free' };
    this.users.set(saved.email, saved);
    return saved;
  }

  async updateUserPassword(email: string, passwordHash: string): Promise<boolean> {
    const user = this.users.get(email);
    if (!user) return false;
    user.passwordHash = passwordHash;
    return true;
  }

  async updateUserProfile(input: {
    id: string;
    name?: string;
    email?: string;
    phone?: string;
    avatarUri?: string | null;
    updatedAt: Date;
  }): Promise<UserRecord | null> {
    const user = await this.findUserById(input.id);
    if (!user) return null;
    if (input.email && input.email !== user.email && this.users.has(input.email)) {
      throw new DuplicateEmailError();
    }
    const previousEmail = user.email;
    const { id, ...patch } = input;
    const record = { ...user, ...patch, id };
    if (input.email && input.email !== previousEmail) this.users.delete(previousEmail);
    this.users.set(record.email, record);
    for (const session of this.sessions.values()) {
      if (session.userId === input.id) session.userEmail = record.email;
    }
    return record;
  }

  async updateUserMemory(input: {
    id: string;
    memory: NonNullable<UserRecord['memory']>;
    updatedAt: Date;
  }): Promise<UserRecord | null> {
    const user = await this.findUserById(input.id);
    if (!user) return null;
    const { id, ...patch } = input;
    Object.assign(user, patch, { id });
    return user;
  }

  async updateUserPlan(input: {
    id: string;
    plan: NonNullable<UserRecord['plan']>;
    updatedAt: Date;
  }): Promise<UserRecord | null> {
    const user = await this.findUserById(input.id);
    if (!user) return null;
    user.plan = input.plan;
    user.updatedAt = input.updatedAt;
    return user;
  }

  async deleteVerification(
    email: string,
    purpose: VerificationRecord['purpose'],
  ): Promise<void> {
    const verification = this.verifications.get(email);
    if (verification?.purpose === purpose) this.verifications.delete(email);
  }

  async createSession(session: NewSession): Promise<SessionRecord> {
    const saved = { ...session, id: String(this.nextSessionId++) };
    this.sessions.set(saved.id, saved);
    return saved;
  }

  async findActiveSessionById(input: {
    id: string;
    userId: string;
    now: Date;
  }): Promise<SessionRecord | null> {
    const session = this.sessions.get(input.id);
    if (
      !session ||
      session.userId !== input.userId ||
      session.revokedAt ||
      session.expiresAt.getTime() <= input.now.getTime()
    ) {
      return null;
    }
    return session;
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

  async revokeActiveSessionsByUserId(userId: string, revokedAt: Date): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.userId === userId && !session.revokedAt) session.revokedAt = revokedAt;
    }
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
