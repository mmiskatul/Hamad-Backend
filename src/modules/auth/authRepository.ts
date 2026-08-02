import type { Plan } from '../plans/plans.js';

export type UserRole = 'user' | 'admin';

export type UserRecord = {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  createdAt: Date;
  role?: UserRole;
  plan?: Plan;
  phone?: string;
  avatarUri?: string | null;
  memory?: {
    enabled: boolean;
    nickname: string;
    occupation: string;
    about: string;
    summary: string;
    summaryUpdatedAt?: Date | null;
  };
  updatedAt?: Date;
};

export type VerificationRecord = {
  email: string;
  purpose: 'registration' | 'password_reset';
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
  findUserById(id: string): Promise<UserRecord | null>;
  saveVerification(input: {
    email: string;
    purpose: VerificationRecord['purpose'];
    codeHash: string;
    expiresAt: Date;
  }): Promise<void>;
  findVerification(
    email: string,
    purpose: VerificationRecord['purpose'],
  ): Promise<VerificationRecord | null>;
  incrementVerificationAttempts(
    email: string,
    purpose: VerificationRecord['purpose'],
  ): Promise<void>;
  markVerificationComplete(input: {
    email: string;
    purpose: VerificationRecord['purpose'];
    verificationTokenHash: string;
    expiresAt: Date;
    verifiedAt: Date;
  }): Promise<void>;
  createUser(user: NewUser): Promise<UserRecord>;
  updateUserPassword(email: string, passwordHash: string): Promise<boolean>;
  updateUserProfile(input: {
    id: string;
    name?: string;
    email?: string;
    phone?: string;
    avatarUri?: string | null;
    updatedAt: Date;
  }): Promise<UserRecord | null>;
  updateUserMemory(input: {
    id: string;
    memory: NonNullable<UserRecord['memory']>;
    updatedAt: Date;
  }): Promise<UserRecord | null>;
  updateUserPlan(input: {
    id: string;
    plan: Plan;
    updatedAt: Date;
  }): Promise<UserRecord | null>;
  deleteVerification(email: string, purpose: VerificationRecord['purpose']): Promise<void>;
  createSession(session: NewSession): Promise<SessionRecord>;
  findActiveSessionById(input: {
    id: string;
    userId: string;
    now: Date;
  }): Promise<SessionRecord | null>;
  findSessionByTokenHash(sessionTokenHash: string): Promise<SessionRecord | null>;
  rotateSessionRefreshToken(input: {
    id: string;
    currentRefreshTokenHash: string;
    nextRefreshTokenHash: string;
    lastUsedAt: Date;
  }): Promise<boolean>;
  revokeSessionByTokenHash(sessionTokenHash: string, revokedAt: Date): Promise<void>;
  revokeActiveSessionsByUserId(userId: string, revokedAt: Date): Promise<void>;
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
