import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3-multiple-ciphers';
import type { FastifyInstance } from 'fastify';
import { InMemorySecretStore } from '../../server/auth/SecretStore.js';
import { openDatabase } from '../../server/db/connection.js';
import { SessionTokens } from '../../server/crypto/SessionTokens.js';
import { EventBus } from '../../server/eventBus.js';
import { buildServer } from '../../server/server.js';
import { ProviderRegistry } from '../../server/providers/ProviderRegistry.js';
import { SyncManager } from '../../server/sync/SyncManager.js';
import type { ImapConfig } from '../../server/providers/ProviderInterface.js';
import { FakeEmailProvider } from './fakeProvider.js';

export interface TestServer {
  app: FastifyInstance;
  store: InMemorySecretStore;
  db: Database.Database;
  sessions: SessionTokens;
  eventBus: EventBus;
  session: string;
  bootstrap: string;
  providers: ProviderRegistry;
  sync: SyncManager;
  madeProviders: FakeEmailProvider[];
}

/** Builds a fully-wired server against a temp encrypted DB and an in-memory secret store. */
export async function makeTestServer(
  opts: { consumeBootstrap?: boolean; pwaDir?: string } = {},
): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), 'secretary-srv-'));
  const store = new InMemorySecretStore();
  const db = openDatabase(join(dir, 'secretary.db'), store);
  const sessions = new SessionTokens(store);
  const eventBus = new EventBus();
  const providers = new ProviderRegistry();
  const sync = new SyncManager(db, providers, eventBus);
  const madeProviders: FakeEmailProvider[] = [];
  const providerFactory = (config: ImapConfig): FakeEmailProvider => {
    const p = new FakeEmailProvider(config.accountId, []);
    madeProviders.push(p);
    return p;
  };
  const app = buildServer({
    db,
    sessions,
    eventBus,
    origin: 'https://localhost:47824',
    secrets: store,
    providers,
    sync,
    providerFactory,
    ...(opts.pwaDir ? { pwaDir: opts.pwaDir } : {}),
  });
  await app.ready();

  // Capture the bootstrap token before (optionally) consuming it.
  const bootstrap = sessions.currentBootstrapToken();
  // A valid bearer token for protected-route tests (default: consume bootstrap).
  const session =
    (opts.consumeBootstrap ?? true) ? sessions.exchangeBootstrap(bootstrap).token : '';
  return { app, store, db, sessions, eventBus, session, bootstrap, providers, sync, madeProviders };
}
