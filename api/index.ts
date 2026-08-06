/**
 * Vercel serverless entrypoint.
 *
 * Vercel Node functions receive a Node-compatible (req, res) pair per request.
 * The application normally lives in `src/index.ts` and listens on a TCP port;
 * here we build the Fastify app without calling `.listen()` and forward each
 * incoming request to its underlying http.Server.
 *
 * `validateProductionEnvironment()` is intentionally NOT called here so a
 * missing Vercel env var surfaces on the project's Environment Variables page
 * rather than masking every request as a generic 500.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { buildApp } from '../src/app.js';

const app = buildApp();
await app.ready();

/*
 * Fastify's underlying http.Server handles requests via the standard
 * 'request' event. Emitting it with the (req, res) pair Vercel hands us
 * routes the request through the same code path the listening server uses,
 * and keeps the type contract intact.
 */
export default function handler(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  app.server.emit('request', req, res);
}