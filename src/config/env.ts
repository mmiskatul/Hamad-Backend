import 'dotenv/config';

function positivePort(value: string | undefined): number {
  const port = Number(value ?? 4000);
  return Number.isInteger(port) && port > 0 ? port : 4000;
}

export const env = {
  host: process.env.HOST ?? '0.0.0.0',
  port: positivePort(process.env.PORT),
  logLevel: process.env.LOG_LEVEL ?? 'info',
} as const;
