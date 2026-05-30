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

export interface TestServer {
  app: FastifyInstance;
  store: InMemorySecretStore;
  db: Database.Database;
  sessions: SessionTokens;
  eventBus: EventBus;
  session: string;
}

/** Builds a fully-wired server against a temp encrypted DB and an in-memory secret store. */
export async function makeTestServer(): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), 'secretary-srv-'));
  const store = new InMemorySecretStore();
  const db = openDatabase(join(dir, 'secretary.db'), store);
  const sessions = new SessionTokens(store);
  const eventBus = new EventBus();
  const app = buildServer({ db, sessions, eventBus, origin: 'https://localhost:47824' });
  await app.ready();

  // A valid bearer token for protected-route tests.
  const session = sessions.exchangeBootstrap(sessions.currentBootstrapToken()).token;
  return { app, store, db, sessions, eventBus, session };
}
