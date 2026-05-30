import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3-multiple-ciphers';
import { SecretaryError } from '@secretary/shared-types';
import type { SessionTokens } from './crypto/SessionTokens.js';
import type { EventBus } from './eventBus.js';
import { registerHealthRoutes } from './api/health.js';

export interface ServerDeps {
  db: Database.Database;
  sessions: SessionTokens;
  eventBus: EventBus;
  /** Exact PWA origin allowed by CORS (no wildcards). */
  origin: string;
}

/** Routes that do not require a session token. */
const PUBLIC_PATHS = new Set(['/api/v1/health', '/api/v1/auth/session']);

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  app.register(cors, { origin: deps.origin, credentials: true });

  // Auth guard: every route except PUBLIC_PATHS requires a valid bearer session token.
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? req.url;
    if (PUBLIC_PATHS.has(path)) return;
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token || !deps.sessions.validateSession(token)) {
      reply.code(401).send({ error: { code: 'unauthorized', message: 'Unauthorized' } });
    }
  });

  // Unified error envelope.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof SecretaryError) {
      reply.code(err.status).send({ error: { code: err.code, message: err.message } });
      return;
    }
    reply.code(500).send({ error: { code: 'internal_error', message: 'Internal server error' } });
  });

  // Keep unknown routes / method mismatches on the same {error} envelope as everything else.
  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
  });

  app.register(
    async (api) => {
      registerHealthRoutes(api);
      // Route groups registered in later tasks:
      // registerAuthRoutes(api, deps);
      // registerSettingsRoutes(api, deps);
      // registerPushRoutes(api, deps);
      // registerEventRoutes(api, deps);
    },
    { prefix: '/api/v1' },
  );

  return app;
}
