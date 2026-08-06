/**
 * Vercel serverless entrypoint.
 *
 * Vercel Node functions receive a Node-compatible (req, res) pair per request.
 * The application normally lives in `src/index.ts` and listens on a TCP port;
 * here we build the Fastify app without calling `.listen()` and forward each
 * incoming request to its underlying http.Server (which is itself a Node
 * `(req, res) => void` listener).
 *
 * `validateProductionEnvironment()` is intentionally NOT called here so a
 * missing Vercel env var surfaces on the project's Environment Variables page
 * rather than masking every request as a generic 500.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { buildApp } from '../src/app.js';

const app = buildApp();

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  await app.ready();
  app.server(req, res);
}