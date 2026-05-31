import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { KeychainStore } from './auth/KeychainStore.js';
import { openDatabase } from './db/connection.js';
import { SessionTokens } from './crypto/SessionTokens.js';
import { EventBus } from './eventBus.js';
import { buildServer } from './server.js';
import { loadHttpsOptions } from './httpsOptions.js';
import { evaluateFirstRun } from './setup/firstRun.js';
import { ProviderRegistry } from './providers/ProviderRegistry.js';
import { SyncManager } from './sync/SyncManager.js';
import { ImapProvider } from './providers/ImapProvider.js';
import type { ImapConfig } from './providers/ProviderInterface.js';
import { buildImapConfig } from './providers/imapConfig.js';
import type { AccountRow } from './db/schema.js';

const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger({
    level: config.logLevel,
    pretty: config.logPretty,
    filePath: join(config.dataDir, 'logs', 'service.log'),
  });

  const store = new KeychainStore();
  const db = openDatabase(join(config.dataDir, 'secretary.db'), store);
  const sessions = new SessionTokens(store);
  const eventBus = new EventBus();

  // Write the single-use bootstrap token to a user-scoped file so the local PWA
  // (or a manual curl handshake) can exchange it for a session token.
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(
    join(config.dataDir, 'bootstrap-token.txt'),
    sessions.currentBootstrapToken(),
    'utf8',
  );
  const providers = new ProviderRegistry();
  const sync = new SyncManager(db, providers, eventBus);
  const providerFactory = (cfg: ImapConfig) => new ImapProvider(cfg);

  const setup = evaluateFirstRun(store, config.dataDir, config.gatewayUseCfHeaders);
  log.info({ needsSetup: setup.needsSetup, missing: setup.missing }, 'first-run evaluated');

  const https = loadHttpsOptions(config.certPath, config.keyPath);
  const app = buildServer({
    db,
    sessions,
    eventBus,
    origin: `https://localhost:${config.port}`,
    https,
    pwaDir: join(here, '..', 'pwa'),
    secrets: store,
    providers,
    sync,
    providerFactory,
  });

  await app.listen({ port: config.port, host: config.host });
  log.info({ port: config.port }, 'service listening');

  // Signal readiness to a parent (Electron) process if forked.
  if (process.send) process.send({ type: 'ready', port: config.port });

  // Resume sync for every enabled IMAP account (rebuild the provider from its
  // keychain password, register it, and start watching).
  const enabled = db
    .prepare("SELECT * FROM accounts WHERE is_enabled = 1 AND provider = 'imap'")
    .all() as AccountRow[];
  for (const acc of enabled) {
    const pass = acc.imap_password_keychain_handle
      ? store.get(acc.imap_password_keychain_handle)
      : null;
    if (!pass) {
      log.warn({ accountId: acc.id }, 'skipping account resume: no stored password');
      continue;
    }
    try {
      providers.set(providerFactory(buildImapConfig(acc, acc.email_address, pass)));
      void sync.initialSync(acc.id);
    } catch (err) {
      log.warn(
        { accountId: acc.id, err: err instanceof Error ? err.message : 'unknown' },
        'account resume failed',
      );
    }
  }

  // Graceful shutdown: close the server (flushes in-flight responses) and the DB
  // (checkpoints WAL) so a tray Quit / Electron kill doesn't leave -wal/-shm behind.
  let shuttingDown = false;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      log.info({ sig }, 'shutting down');
      void app
        .close()
        .catch(() => undefined)
        .then(() => {
          db.close();
          process.exit(0);
        });
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
