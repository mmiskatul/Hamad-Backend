import { DuplicateEmailError, type AuthRepository, type UserRecord } from '../auth/authRepository.js';
import { normaliseEmail } from '../auth/authService.js';

export type PublicProfile = {
  id: string;
  name: string;
  email: string;
  phone: string;
  avatarUri: string | null;
  createdAt: string;
  updatedAt: string;
};

export class ProfileError extends Error {
  constructor(
    readonly code: 'PROFILE_NOT_FOUND' | 'EMAIL_ALREADY_REGISTERED',
    message: string,
    readonly statusCode: 404 | 409,
  ) {
    super(message);
    this.name = 'ProfileError';
  }
}

export class ProfileService {
  constructor(private readonly repository: AuthRepository) {}

  async get(userId: string): Promise<PublicProfile> {
    const user = await this.repository.findUserById(userId);
    if (!user) throw new ProfileError('PROFILE_NOT_FOUND', 'Profile not found.', 404);
    return publicProfile(user);
  }

  async update(
    userId: string,
    patch: { name?: string; email?: string; phone?: string; avatarUri?: string | null },
  ): Promise<PublicProfile> {
    try {
      const user = await this.repository.updateUserProfile({
        id: userId,
        ...(patch.name === undefined ? {} : { name: patch.name.trim() }),
        ...(patch.email === undefined ? {} : { email: normaliseEmail(patch.email) }),
        ...(patch.phone === undefined ? {} : { phone: patch.phone.trim() }),
        ...(patch.avatarUri === undefined ? {} : { avatarUri: patch.avatarUri?.trim() || null }),
        updatedAt: new Date(),
      });
      if (!user) throw new ProfileError('PROFILE_NOT_FOUND', 'Profile not found.', 404);
      return publicProfile(user);
    } catch (error) {
      if (error instanceof DuplicateEmailError) {
        throw new ProfileError(
          'EMAIL_ALREADY_REGISTERED',
          'An account already exists for this email address.',
          409,
        );
      }
      throw error;
    }
  }
}

function publicProfile(user: UserRecord): PublicProfile {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone ?? '',
    avatarUri: user.avatarUri ?? null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: (user.updatedAt ?? user.createdAt).toISOString(),
  };
}
