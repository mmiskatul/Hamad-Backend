import {
  createHmac,
  randomBytes,
  randomInt,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import type { EmailSender } from '../email/emailSender.js';
import {
  DuplicateEmailError,
  type AuthRepository,
  type UserRecord,
} from './authRepository.js';

const scrypt = promisify(nodeScrypt);
const MAX_VERIFICATION_CODE_ATTEMPTS = 5;
const REGISTRATION_PROOF_TTL_MINUTES = 15;
const PASSWORD_RESET_PROOF_TTL_MINUTES = 15;

export type AuthServiceOptions = {
  verificationSecret: string;
  verificationCodeExpiresMinutes: number;
  emailSender: EmailSender;
};

export type AuthErrorCode =
  | 'EMAIL_ALREADY_REGISTERED'
  | 'EMAIL_NOT_REGISTERED'
  | 'EMAIL_DELIVERY_FAILED'
  | 'INVALID_OR_EXPIRED_CODE'
  | 'INVALID_REGISTRATION_TOKEN'
  | 'INVALID_PASSWORD_RESET_TOKEN'
  | 'INVALID_CREDENTIALS'
  | 'CURRENT_PASSWORD_INCORRECT';

export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export class AuthService {
  constructor(
    private readonly repository: AuthRepository,
    private readonly options: AuthServiceOptions,
  ) {}

  async checkEmail(email: string): Promise<boolean> {
    return (await this.repository.findUserByEmail(normaliseEmail(email))) !== null;
  }

  async requestRegistrationCode(email: string): Promise<{ email: string; expiresInSeconds: number }> {
    const normalised = normaliseEmail(email);
    if (await this.repository.findUserByEmail(normalised)) {
      throw new AuthError('EMAIL_ALREADY_REGISTERED', 'An account already exists for this email address.');
    }

    const code = randomInt(0, 10_000).toString().padStart(4, '0');
    const expiresInSeconds = this.options.verificationCodeExpiresMinutes * 60;
    await this.repository.saveVerification({
      email: normalised,
      purpose: 'registration',
      codeHash: this.hashSecret(code),
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
    });

    try {
      await this.options.emailSender.sendRegistrationCode({
        to: normalised,
        code,
        expiresInMinutes: this.options.verificationCodeExpiresMinutes,
      });
    } catch {
      await this.repository.deleteVerification(normalised, 'registration');
      throw new AuthError(
        'EMAIL_DELIVERY_FAILED',
        'We could not send the verification email. Please try again later.',
      );
    }

    return { email: normalised, expiresInSeconds };
  }

  async verifyRegistrationCode(email: string, code: string): Promise<string> {
    const normalised = normaliseEmail(email);
    const verification = await this.repository.findVerification(normalised, 'registration');
    const invalid =
      !verification ||
      verification.expiresAt.getTime() <= Date.now() ||
      verification.attempts >= MAX_VERIFICATION_CODE_ATTEMPTS ||
      !verification.codeHash ||
      !safeEqual(verification.codeHash, this.hashSecret(code));

    if (invalid) {
      if (verification) {
        await this.repository.incrementVerificationAttempts(normalised, 'registration');
      }
      throw new AuthError('INVALID_OR_EXPIRED_CODE', 'The verification code is invalid or has expired.');
    }

    const token = randomBytes(32).toString('base64url');
    const verifiedAt = new Date();
    await this.repository.markVerificationComplete({
      email: normalised,
      purpose: 'registration',
      verificationTokenHash: this.hashSecret(token),
      verifiedAt,
      expiresAt: new Date(
        verifiedAt.getTime() + REGISTRATION_PROOF_TTL_MINUTES * 60 * 1000,
      ),
    });
    return token;
  }

  async register(input: {
    email: string;
    name: string;
    password: string;
    verificationToken: string;
  }): Promise<UserRecord> {
    const email = normaliseEmail(input.email);
    const verification = await this.repository.findVerification(email, 'registration');
    if (
      !verification?.verifiedAt ||
      !verification.verificationTokenHash ||
      verification.expiresAt.getTime() <= Date.now() ||
      !safeEqual(verification.verificationTokenHash, this.hashSecret(input.verificationToken))
    ) {
      throw new AuthError('INVALID_REGISTRATION_TOKEN', 'Verify your email again before creating the account.');
    }

    try {
      const user = await this.repository.createUser({
        email,
        name: input.name.trim(),
        passwordHash: await hashPassword(input.password),
        createdAt: new Date(),
        plan: 'free',
      });
      await this.repository.deleteVerification(email, 'registration');
      return user;
    } catch (error) {
      if (error instanceof DuplicateEmailError) {
        throw new AuthError('EMAIL_ALREADY_REGISTERED', error.message);
      }
      throw error;
    }
  }

  async login(email: string, password: string): Promise<UserRecord> {
    const user = await this.repository.findUserByEmail(normaliseEmail(email));
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      throw new AuthError('INVALID_CREDENTIALS', 'The email or password is incorrect.');
    }
    return user;
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.repository.findUserById(userId);
    if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new AuthError('CURRENT_PASSWORD_INCORRECT', 'The current password is incorrect.');
    }
    await this.repository.updateUserPassword(user.email, await hashPassword(newPassword));
  }

  async requestPasswordResetCode(
    email: string,
  ): Promise<{ email: string; expiresInSeconds: number }> {
    const normalised = normaliseEmail(email);
    if (!(await this.repository.findUserByEmail(normalised))) {
      throw new AuthError('EMAIL_NOT_REGISTERED', 'No account exists for this email address.');
    }

    const code = randomInt(0, 10_000).toString().padStart(4, '0');
    const expiresInSeconds = this.options.verificationCodeExpiresMinutes * 60;
    await this.repository.saveVerification({
      email: normalised,
      purpose: 'password_reset',
      codeHash: this.hashSecret(code),
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
    });

    try {
      await this.options.emailSender.sendPasswordResetCode({
        to: normalised,
        code,
        expiresInMinutes: this.options.verificationCodeExpiresMinutes,
      });
    } catch {
      await this.repository.deleteVerification(normalised, 'password_reset');
      throw new AuthError(
        'EMAIL_DELIVERY_FAILED',
        'We could not send the password reset email. Please try again later.',
      );
    }

    return { email: normalised, expiresInSeconds };
  }

  async verifyPasswordResetCode(email: string, code: string): Promise<string> {
    const normalised = normaliseEmail(email);
    const verification = await this.repository.findVerification(
      normalised,
      'password_reset',
    );
    const invalid =
      !verification ||
      verification.expiresAt.getTime() <= Date.now() ||
      verification.attempts >= MAX_VERIFICATION_CODE_ATTEMPTS ||
      !verification.codeHash ||
      !safeEqual(verification.codeHash, this.hashSecret(code));

    if (invalid) {
      if (verification) {
        await this.repository.incrementVerificationAttempts(normalised, 'password_reset');
      }
      throw new AuthError(
        'INVALID_OR_EXPIRED_CODE',
        'The verification code is invalid or has expired.',
      );
    }

    const token = randomBytes(32).toString('base64url');
    const verifiedAt = new Date();
    await this.repository.markVerificationComplete({
      email: normalised,
      purpose: 'password_reset',
      verificationTokenHash: this.hashSecret(token),
      verifiedAt,
      expiresAt: new Date(
        verifiedAt.getTime() + PASSWORD_RESET_PROOF_TTL_MINUTES * 60 * 1000,
      ),
    });
    return token;
  }

  async resetPassword(input: {
    email: string;
    password: string;
    resetToken: string;
  }): Promise<void> {
    const email = normaliseEmail(input.email);
    const verification = await this.repository.findVerification(email, 'password_reset');
    if (
      !verification?.verifiedAt ||
      !verification.verificationTokenHash ||
      verification.expiresAt.getTime() <= Date.now() ||
      !safeEqual(verification.verificationTokenHash, this.hashSecret(input.resetToken))
    ) {
      throw new AuthError(
        'INVALID_PASSWORD_RESET_TOKEN',
        'Verify your reset code again before changing the password.',
      );
    }

    const user = await this.repository.findUserByEmail(email);
    if (!user) {
      throw new AuthError('EMAIL_NOT_REGISTERED', 'No account exists for this email address.');
    }

    const updated = await this.repository.updateUserPassword(
      email,
      await hashPassword(input.password),
    );
    if (!updated) {
      throw new AuthError('EMAIL_NOT_REGISTERED', 'No account exists for this email address.');
    }

    const now = new Date();
    await this.repository.revokeActiveSessionsByUserId(user.id, now);
    await this.repository.deleteVerification(email, 'password_reset');
  }

  private hashSecret(value: string): string {
    return createHmac('sha256', this.options.verificationSecret).update(value).digest('hex');
  }
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return 'scrypt$' + salt.toString('base64url') + '$' + derived.toString('base64url');
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [algorithm, saltValue, hashValue] = storedHash.split('$');
  if (algorithm !== 'scrypt' || !saltValue || !hashValue) return false;

  try {
    const salt = Buffer.from(saltValue, 'base64url');
    const expected = Buffer.from(hashValue, 'base64url');
    const actual = (await scrypt(password, salt, expected.length)) as Buffer;
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
