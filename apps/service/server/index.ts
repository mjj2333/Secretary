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
  });

  await app.listen({ port: config.port, host: config.host });
  log.info({ port: config.port }, 'service listening');

  // Signal readiness to a parent (Electron) process if forked.
  if (process.send) process.send({ type: 'ready', port: config.port });

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
