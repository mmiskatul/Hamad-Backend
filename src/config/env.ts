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

function trimmed(value: string | undefined): string {
  return value?.trim() ?? '';
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
  // Provider credentials remain server-only; Mobile receives availability metadata.
  aiRequestTimeoutMs: positiveInteger(process.env.AI_REQUEST_TIMEOUT_MS, 60_000),
  aiMaxContextMessages: positiveInteger(process.env.AI_MAX_CONTEXT_MESSAGES, 30),
  openAi: {
    enabled: boolean(process.env.OPENAI_ENABLED),
    apiKey: trimmed(process.env.OPENAI_API_KEY),
    baseUrl: trimmed(process.env.OPENAI_BASE_URL) || 'https://api.openai.com/v1',
    model: trimmed(process.env.OPENAI_MODEL) || 'gpt-5.6',
  },
  deepSeek: {
    enabled: boolean(process.env.DEEPSEEK_ENABLED),
    apiKey: trimmed(process.env.DEEPSEEK_API_KEY),
    baseUrl: trimmed(process.env.DEEPSEEK_BASE_URL) || 'https://api.deepseek.com',
    model: trimmed(process.env.DEEPSEEK_MODEL) || 'deepseek-v4-flash',
  },
  gemini: {
    enabled: boolean(process.env.GEMINI_ENABLED),
    apiKey: trimmed(process.env.GEMINI_API_KEY),
    baseUrl:
      trimmed(process.env.GEMINI_BASE_URL) ||
      'https://generativelanguage.googleapis.com/v1beta',
    model: trimmed(process.env.GEMINI_MODEL) || 'gemini-3.6-flash',
  },
  anthropic: {
    enabled: boolean(process.env.ANTHROPIC_ENABLED),
    apiKey: trimmed(process.env.ANTHROPIC_API_KEY),
    baseUrl: trimmed(process.env.ANTHROPIC_BASE_URL) || 'https://api.anthropic.com/v1',
    model: trimmed(process.env.ANTHROPIC_MODEL) || 'claude-sonnet-5',
  },
  perplexity: {
    enabled: boolean(process.env.PERPLEXITY_ENABLED),
    apiKey: trimmed(process.env.PERPLEXITY_API_KEY),
    baseUrl: trimmed(process.env.PERPLEXITY_BASE_URL) || 'https://api.perplexity.ai',
    model: trimmed(process.env.PERPLEXITY_MODEL) || 'sonar',
  },
  xAi: {
    enabled: boolean(process.env.XAI_ENABLED),
    apiKey: trimmed(process.env.XAI_API_KEY),
    baseUrl: trimmed(process.env.XAI_BASE_URL) || 'https://api.x.ai/v1',
    model: trimmed(process.env.XAI_MODEL) || 'grok-4.5',
  },
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

  for (const [name, provider] of Object.entries({
    OPENAI: env.openAi,
    DEEPSEEK: env.deepSeek,
    GEMINI: env.gemini,
    ANTHROPIC: env.anthropic,
    PERPLEXITY: env.perplexity,
    XAI: env.xAi,
  })) {
    if (provider.enabled && !provider.apiKey) missing.push(`${name}_API_KEY`);
  }

  if (missing.length > 0) {
    throw new Error(`Missing or insecure production configuration: ${missing.join(', ')}`);
  }
}
