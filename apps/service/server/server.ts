import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3-multiple-ciphers';
import { SecretaryError } from '@secretary/shared-types';
import type { SessionTokens } from './crypto/SessionTokens.js';
import type { EventBus } from './eventBus.js';
import type { HttpsOptions } from './httpsOptions.js';
import { registerHealthRoutes } from './api/health.js';
import { registerAuthRoutes } from './api/auth.js';
import { registerSettingsRoutes } from './api/settings.js';
import { registerPushRoutes } from './api/push.js';
import { registerEventRoutes } from './api/events.js';
import type { ProviderRegistry } from './providers/ProviderRegistry.js';
import type { SyncManager } from './sync/SyncManager.js';
import type { SecretStore } from './auth/SecretStore.js';
import type { EmailProvider, ImapConfig } from './providers/ProviderInterface.js';
import { registerAccountsRoutes } from './api/accounts.js';
import { registerThreadsRoutes } from './api/threads.js';

export interface ServerDeps {
  db: Database.Database;
  sessions: SessionTokens;
  eventBus: EventBus;
  /** Exact PWA origin allowed by CORS (no wildcards). */
  origin: string;
  https?: HttpsOptions;
  /** Directory containing the placeholder/PWA static files. Omitted in tests by default. */
  pwaDir?: string;
  providers: ProviderRegistry;
  sync: SyncManager;
  secrets: SecretStore;
  /** Builds a provider for a resolved config — injectable so tests use a fake. */
  providerFactory: (config: ImapConfig) => EmailProvider;
}

/**
 * Method+path pairs reachable without a session token: health, and the bootstrap
 * exchange (chicken-and-egg — you have no session yet). Everything else, including
 * DELETE /auth/session (revoke), requires a valid bearer token.
 */
const PUBLIC_ROUTES = new Set(['GET /api/v1/health', 'POST /api/v1/auth/session']);

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app: FastifyInstance = deps.https
    ? (Fastify({
        logger: false,
        https: { cert: deps.https.cert, key: deps.https.key },
      }) as unknown as FastifyInstance)
    : Fastify({ logger: false });

  app.register(cors, { origin: deps.origin, credentials: true });

  // Auth guard: every route except PUBLIC_PATHS requires a valid bearer session token.
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? req.url;
    // Static assets (the PWA) are served without auth; only /api/v1 is guarded.
    if (!path.startsWith('/api/v1')) return;
    if (PUBLIC_ROUTES.has(`${req.method} ${path}`)) return;
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token || !deps.sessions.validateSession(token)) {
      reply.code(401).send({ error: { code: 'unauthorized', message: 'Unauthorized' } });
    }
  });

  // Unified error envelope.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof SecretaryError) {
      reply.code(err.status).send({ error: { code: err.code, message: err.message } });
      return;
    }
    // Fastify (and similar) errors carry their own statusCode — e.g. a 400 for a
    // malformed JSON body. Surface client errors instead of masking them as 500.
    const status =
      typeof (err as { statusCode?: unknown }).statusCode === 'number'
        ? (err as { statusCode: number }).statusCode
        : 500;
    if (status >= 400 && status < 500) {
      const message = err instanceof Error ? err.message : 'Bad request';
      reply.code(status).send({ error: { code: 'bad_request', message } });
      return;
    }
    // Last-resort: log the real cause server-side (never leak it in the response).
    console.error(`[secretary] unhandled error on ${req.method} ${req.url}:`, err);
    reply.code(500).send({ error: { code: 'internal_error', message: 'Internal server error' } });
  });

  // Keep unknown routes / method mismatches on the same {error} envelope as everything else.
  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
  });

  if (deps.pwaDir) {
    const html = readFileSync(join(deps.pwaDir, 'index.html'), 'utf8');
    app.get('/', async (_req, reply) => {
      reply.header('content-type', 'text/html').send(html);
    });
  }

  app.register(
    async (api) => {
      registerHealthRoutes(api);
      registerAuthRoutes(api, deps);
      registerSettingsRoutes(api, deps);
      registerPushRoutes(api, deps);
      registerEventRoutes(api, deps);
      registerAccountsRoutes(api, deps);
      registerThreadsRoutes(api, deps);
    },
    { prefix: '/api/v1' },
  );

  return app;
}
