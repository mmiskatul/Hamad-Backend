import { setServers } from 'node:dns';
import { buildApp } from './app.js';
import { env, validateProductionEnvironment } from './config/env.js';

validateProductionEnvironment();
if (env.mongoDnsServers.length > 0) setServers(env.mongoDnsServers);
const app = buildApp();

try {
  await app.listen({ host: env.host, port: env.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
