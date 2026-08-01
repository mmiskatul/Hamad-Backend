import { ObjectId, type Collection, type Db, type WithId } from 'mongodb';
import { MongoServerError } from 'mongodb';
import {
  DuplicateEmailError,
  type AuthRepository,
  type NewSession,
  type NewUser,
  type SessionRecord,
  type UserRecord,
  type VerificationRecord,
} from './authRepository.js';

type UserDocument = Omit<UserRecord, 'id'>;
type VerificationDocument = VerificationRecord;
type SessionDocument = Omit<SessionRecord, 'id'>;

export class MongoAuthRepository implements AuthRepository {
  private readonly users: Collection<UserDocument>;
  private readonly verifications: Collection<VerificationDocument>;
  private readonly sessions: Collection<SessionDocument>;
  private readonly indexesReady: Promise<unknown>;

  constructor(db: Db) {
    this.users = db.collection<UserDocument>('users');
    this.verifications = db.collection<VerificationDocument>('registration_verifications');
    this.sessions = db.collection<SessionDocument>('auth_sessions');
    this.indexesReady = Promise.all([
      this.users.createIndex({ email: 1 }, { unique: true }),
      this.verifications.createIndex({ email: 1 }, { unique: true }),
      this.verifications.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.sessions.createIndex({ sessionTokenHash: 1 }, { unique: true }),
      this.sessions.createIndex({ userId: 1, expiresAt: 1 }),
      this.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    ]);
  }

  private async ready(): Promise<void> {
    await this.indexesReady;
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    await this.ready();
    const user = await this.users.findOne({ email });
    return user ? this.toUserRecord(user) : null;
  }

  async saveVerification(input: {
    email: string;
    codeHash: string;
    expiresAt: Date;
  }): Promise<void> {
    await this.ready();
    await this.verifications.updateOne(
      { email: input.email },
      {
        $set: { ...input, attempts: 0 },
        $unset: { verificationTokenHash: '', verifiedAt: '' },
      },
      { upsert: true },
    );
  }

  async findVerification(email: string): Promise<VerificationRecord | null> {
    await this.ready();
    return this.verifications.findOne({ email });
  }

  async incrementVerificationAttempts(email: string): Promise<void> {
    await this.ready();
    await this.verifications.updateOne({ email }, { $inc: { attempts: 1 } });
  }

  async markVerificationComplete(input: {
    email: string;
    verificationTokenHash: string;
    expiresAt: Date;
    verifiedAt: Date;
  }): Promise<void> {
    await this.ready();
    await this.verifications.updateOne(
      { email: input.email },
      {
        $set: {
          verificationTokenHash: input.verificationTokenHash,
          verifiedAt: input.verifiedAt,
          expiresAt: input.expiresAt,
        },
        $unset: { codeHash: '' },
      },
    );
  }

  async createUser(user: NewUser): Promise<UserRecord> {
    await this.ready();
    try {
      const result = await this.users.insertOne(user);
      return { ...user, id: result.insertedId.toHexString() };
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) {
        throw new DuplicateEmailError();
      }
      throw error;
    }
  }

  async deleteVerification(email: string): Promise<void> {
    await this.ready();
    await this.verifications.deleteOne({ email });
  }

  async createSession(session: NewSession): Promise<SessionRecord> {
    await this.ready();
    const result = await this.sessions.insertOne(session);
    return { ...session, id: result.insertedId.toHexString() };
  }

  async findSessionByTokenHash(sessionTokenHash: string): Promise<SessionRecord | null> {
    await this.ready();
    const session = await this.sessions.findOne({ sessionTokenHash });
    return session ? this.toSessionRecord(session) : null;
  }

  async rotateSessionRefreshToken(input: {
    id: string;
    currentRefreshTokenHash: string;
    nextRefreshTokenHash: string;
    lastUsedAt: Date;
  }): Promise<boolean> {
    await this.ready();
    if (!ObjectId.isValid(input.id)) return false;
    const result = await this.sessions.updateOne(
      {
        _id: new ObjectId(input.id),
        refreshTokenHash: input.currentRefreshTokenHash,
        revokedAt: { $exists: false },
        expiresAt: { $gt: input.lastUsedAt },
      },
      {
        $set: {
          refreshTokenHash: input.nextRefreshTokenHash,
          lastUsedAt: input.lastUsedAt,
        },
      },
    );
    return result.modifiedCount === 1;
  }

  async revokeSessionByTokenHash(sessionTokenHash: string, revokedAt: Date): Promise<void> {
    await this.ready();
    await this.sessions.updateOne(
      { sessionTokenHash, revokedAt: { $exists: false } },
      { $set: { revokedAt } },
    );
  }

  async findActiveSessionsByUserId(userId: string, now: Date): Promise<SessionRecord[]> {
    await this.ready();
    const sessions = await this.sessions
      .find({ userId, revokedAt: { $exists: false }, expiresAt: { $gt: now } })
      .sort({ lastUsedAt: -1 })
      .toArray();
    return sessions.map((session) => this.toSessionRecord(session));
  }

  async revokeSessionById(input: {
    id: string;
    userId: string;
    revokedAt: Date;
  }): Promise<boolean> {
    await this.ready();
    if (!ObjectId.isValid(input.id)) return false;
    const result = await this.sessions.updateOne(
      {
        _id: new ObjectId(input.id),
        userId: input.userId,
        revokedAt: { $exists: false },
      },
      { $set: { revokedAt: input.revokedAt } },
    );
    return result.modifiedCount === 1;
  }

  private toUserRecord(document: WithId<UserDocument>): UserRecord {
    const { _id, ...user } = document;
    return { ...user, id: _id.toHexString() };
  }

  private toSessionRecord(document: WithId<SessionDocument>): SessionRecord {
    const { _id, ...session } = document;
    return { ...session, id: _id.toHexString() };
  }
}
