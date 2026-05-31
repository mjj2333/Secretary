import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3-multiple-ciphers';
import { SecretaryError } from '@secretary/shared-types';
import type { ThreadState } from '@secretary/shared-types';
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
import { registerContactsRoutes } from './api/contacts.js';
import { registerDraftsRoutes } from './api/drafts.js';

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
  /** Enqueue a message id for asynchronous classification. */
  classificationQueue: { enqueue(messageId: string): void };
  /** Apply manual thread state overrides. */
  stateMachine: {
    onManual(threadId: string, state: ThreadState, reason?: string): void;
    onOutbound(threadId: string): void;
  };
  /** Synchronously generate a draft for a thread (manual create/regenerate). */
  drafter: {
    draft(
      threadId: string,
      opts?: { rawIntent?: string },
    ): Promise<import('./db/schema.js').DraftRow | null>;
  };
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
    let token = header.startsWith('Bearer ') ? header.slice(7) : '';
    // EventSource cannot set headers, so the SSE stream authenticates via ?token=.
    if (!token && path === '/api/v1/events') {
      const q = (req.query as { token?: unknown }).token;
      if (typeof q === 'string') token = q;
    }
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

  if (deps.pwaDir) {
    const { pwaDir } = deps;
    // Serve built SPA assets (index.html, /assets/*, manifest, sw) without auth — the
    // onRequest guard already skips non-/api/v1 paths.
    app.register(fastifyStatic, { root: pwaDir, wildcard: false });
    // SPA fallback: any non-/api/v1 GET that isn't a real file returns index.html so the
    // client-side router can handle it. /api/v1 keeps its {error} 404 (handler below).
    const indexHtml = readFileSync(join(pwaDir, 'index.html'), 'utf8');
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split('?')[0] ?? req.url;
      if (req.method === 'GET' && !path.startsWith('/api/v1')) {
        reply.header('content-type', 'text/html').send(indexHtml);
        return;
      }
      reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
    });
  } else {
    // No PWA build present (e.g. some tests): keep the plain {error} 404 handler.
    app.setNotFoundHandler((_req, reply) => {
      reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
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
      registerContactsRoutes(api, deps);
      registerDraftsRoutes(api, deps);
    },
    { prefix: '/api/v1' },
  );

  return app;
}
