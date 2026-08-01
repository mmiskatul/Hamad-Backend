import 'dotenv/config';

function positivePort(value: string | undefined, fallback = 4000): number {
  const port = Number(value ?? fallback);
  return Number.isInteger(port) && port > 0 ? port : fallback;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boolean(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() === 'true';
}

export const env = {
  host: process.env.HOST ?? '0.0.0.0',
  port: positivePort(process.env.PORT),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  mongoUrl: process.env.MONGODB_URL ?? 'mongodb://localhost:27017',
  mongoDatabase: process.env.MONGODB_DATABASE ?? 'one_ai_hub',
  mongoDnsServers: (process.env.MONGODB_DNS_SERVERS ?? '')
    .split(',')
    .map((server) => server.trim())
    .filter(Boolean),
  jwtSecret: process.env.JWT_SECRET ?? 'development-only-change-this-jwt-secret',
  accessTokenExpiresIn: process.env.ACCESS_TOKEN_EXPIRES_IN ?? '15m',
  sessionExpiresDays: positiveInteger(process.env.SESSION_EXPIRES_DAYS, 30),
  emailVerificationCodeExpiresMinutes: positiveInteger(
    process.env.EMAIL_VERIFICATION_CODE_EXPIRES_MINUTES,
    10,
  ),
  smtpHost: process.env.SMTP_HOST ?? '',
  smtpPort: positivePort(process.env.SMTP_PORT, 587),
  smtpSecure: boolean(process.env.SMTP_SECURE),
  smtpUser: process.env.SMTP_USER ?? '',
  smtpPassword: process.env.SMTP_PASSWORD ?? '',
  smtpFromEmail: process.env.SMTP_FROM_EMAIL ?? '',
  smtpFromName: process.env.SMTP_FROM_NAME ?? 'One AI Hub',
} as const;

export function validateProductionEnvironment(): void {
  if (process.env.NODE_ENV !== 'production') return;

  const missing: string[] = [];
  const jwtSecret = process.env.JWT_SECRET?.trim() ?? '';
  if (
    jwtSecret.length < 32 ||
    /replace|change-this|development-only/i.test(jwtSecret)
  ) {
    missing.push('JWT_SECRET (at least 32 random characters)');
  }

  for (const [name, value] of Object.entries({
    SMTP_HOST: env.smtpHost,
    SMTP_USER: env.smtpUser,
    SMTP_PASSWORD: env.smtpPassword,
    SMTP_FROM_EMAIL: env.smtpFromEmail,
  })) {
    if (!value.trim()) missing.push(name);
  }

  if (missing.length > 0) {
    throw new Error(`Missing or insecure production configuration: ${missing.join(', ')}`);
  }
}
