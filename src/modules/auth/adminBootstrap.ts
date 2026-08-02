import type { AuthRepository, UserRecord } from './authRepository.js';
import { DuplicateEmailError } from './authRepository.js';
import { hashPassword, normaliseEmail } from './authService.js';

export type AdminBootstrapInput = {
  email: string;
  password: string;
  name: string;
};

export type AdminBootstrapResult = {
  user: UserRecord;
  created: boolean;
};

export async function bootstrapAdminAccount(
  repository: AuthRepository,
  input: AdminBootstrapInput,
): Promise<AdminBootstrapResult> {
  const email = normaliseEmail(input.email);
  const password = input.password;
  const name = input.name.trim() || 'OneAI Administrator';

  if (!email || !password) {
    throw new Error('ADMIN_SEED_EMAIL and ADMIN_SEED_PASSWORD must both be configured.');
  }
  if (password.length < 12) {
    throw new Error('ADMIN_SEED_PASSWORD must contain at least 12 characters.');
  }

  const existing = await repository.findUserByEmail(email);
  if (existing) {
    if (existing.role !== 'admin') {
      throw new Error(
        `ADMIN_SEED_EMAIL already belongs to a non-admin account: ${email}`,
      );
    }
    return { user: existing, created: false };
  }

  try {
    const user = await repository.createUser({
      email,
      name,
      passwordHash: await hashPassword(password),
      createdAt: new Date(),
      role: 'admin',
      plan: 'business',
    });
    return { user, created: true };
  } catch (error) {
    if (!(error instanceof DuplicateEmailError)) throw error;
    const raced = await repository.findUserByEmail(email);
    if (raced?.role === 'admin') return { user: raced, created: false };
    throw error;
  }
}
