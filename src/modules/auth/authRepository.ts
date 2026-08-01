export type UserRecord = {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  createdAt: Date;
};

export type VerificationRecord = {
  email: string;
  codeHash?: string;
  attempts: number;
  expiresAt: Date;
  verificationTokenHash?: string;
  verifiedAt?: Date;
};

export type SessionRecord = {
  id: string;
  userId: string;
  userEmail: string;
  refreshTokenHash: string;
  sessionTokenHash: string;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
  revokedAt?: Date;
  userAgent?: string;
  ipAddress?: string;
};

export type NewUser = Omit<UserRecord, 'id'>;
export type NewSession = Omit<SessionRecord, 'id'>;

export interface AuthRepository {
  findUserByEmail(email: string): Promise<UserRecord | null>;
  saveVerification(input: {
    email: string;
    codeHash: string;
    expiresAt: Date;
  }): Promise<void>;
  findVerification(email: string): Promise<VerificationRecord | null>;
  incrementVerificationAttempts(email: string): Promise<void>;
  markVerificationComplete(input: {
    email: string;
    verificationTokenHash: string;
    expiresAt: Date;
    verifiedAt: Date;
  }): Promise<void>;
  createUser(user: NewUser): Promise<UserRecord>;
  deleteVerification(email: string): Promise<void>;
  createSession(session: NewSession): Promise<SessionRecord>;
  findSessionByTokenHash(sessionTokenHash: string): Promise<SessionRecord | null>;
  rotateSessionRefreshToken(input: {
    id: string;
    currentRefreshTokenHash: string;
    nextRefreshTokenHash: string;
    lastUsedAt: Date;
  }): Promise<boolean>;
  revokeSessionByTokenHash(sessionTokenHash: string, revokedAt: Date): Promise<void>;
  findActiveSessionsByUserId(userId: string, now: Date): Promise<SessionRecord[]>;
  revokeSessionById(input: {
    id: string;
    userId: string;
    revokedAt: Date;
  }): Promise<boolean>;
}

export class DuplicateEmailError extends Error {
  constructor() {
    super('An account already exists for this email address.');
    this.name = 'DuplicateEmailError';
  }
}
