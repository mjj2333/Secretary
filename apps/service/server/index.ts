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
import { StateMachine } from './agent/StateMachine.js';
import { ThreadsRepository } from './db/repositories/ThreadsRepository.js';
import { MessagesRepository } from './db/repositories/MessagesRepository.js';
import { ContactsRepository } from './db/repositories/ContactsRepository.js';
import { SettingsRepository } from './db/repositories/SettingsRepository.js';
import { ActionLogRepository } from './db/repositories/ActionLogRepository.js';
import { FollowUpsRepository } from './db/repositories/FollowUpsRepository.js';
import { StyleExamplesRepository } from './db/repositories/StyleExamplesRepository.js';
import { createGatewayClient, type GatewayClient } from './llm/GatewayClient.js';
import { PromptAssembler } from './agent/PromptAssembler.js';
import { Classifier } from './agent/Classifier.js';
import { Drafter } from './agent/Drafter.js';
import { SequentialQueue } from './agent/SequentialQueue.js';
import { FollowUpEngine } from './agent/FollowUpEngine.js';
import { DraftsRepository } from './db/repositories/DraftsRepository.js';

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

  // Repositories
  const threadsRepo = new ThreadsRepository(db);
  const messagesRepo = new MessagesRepository(db);
  const contactsRepo = new ContactsRepository(db);
  const settingsRepo = new SettingsRepository(db);
  const actionsRepo = new ActionLogRepository(db);
  const followUpsRepo = new FollowUpsRepository(db);
  const styleExamplesRepo = new StyleExamplesRepository(db);

  // GatewayClient — only built when keychain credentials are present
  let gateway: GatewayClient | null = null;
  const gwApiKey = store.get('app.gateway-api-key');
  const gwPayloadKey = store.get('app.payload-key');
  if (gwApiKey && gwPayloadKey) {
    gateway = createGatewayClient({
      gatewayUrl: config.gatewayUrl,
      useCfHeaders: config.gatewayUseCfHeaders,
      apiKey: gwApiKey,
      payloadKey: gwPayloadKey,
      ...(config.gatewayUseCfHeaders
        ? {
            cfClientId: store.get('app.cf-access-id') ?? '',
            cfClientSecret: store.get('app.cf-access-secret') ?? '',
          }
        : {}),
    });
  } else {
    log.warn('gateway credentials missing; classification disabled until setup completes');
  }

  // Agent layer
  const stateMachine = new StateMachine(
    threadsRepo,
    contactsRepo,
    settingsRepo,
    actionsRepo,
    eventBus,
  );
  const promptAssembler = new PromptAssembler(
    messagesRepo,
    threadsRepo,
    contactsRepo,
    settingsRepo,
    styleExamplesRepo,
  );
  const drafter = new Drafter(
    promptAssembler,
    gateway,
    new DraftsRepository(db),
    messagesRepo,
    threadsRepo,
    actionsRepo,
    eventBus,
    settingsRepo,
    log,
  );
  const draftQueue = new SequentialQueue((threadId) =>
    drafter.draft(threadId).then(() => undefined),
  );
  const classifier = new Classifier(
    promptAssembler,
    gateway,
    stateMachine,
    threadsRepo,
    messagesRepo,
    actionsRepo,
    eventBus,
    settingsRepo,
    contactsRepo,
    log,
    Date.now,
    (threadId) => draftQueue.enqueue(threadId),
  );
  const classificationQueue = new SequentialQueue((id) => classifier.classify(id));
  const followUpEngine = new FollowUpEngine(db, threadsRepo, followUpsRepo, actionsRepo, eventBus);

  const providers = new ProviderRegistry();
  const sync = new SyncManager(db, providers, eventBus, Date.now, {
    enqueueClassification: (messageId) => classificationQueue.enqueue(messageId),
    onOutbound: (threadId) => stateMachine.onOutbound(threadId),
  });
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
    classificationQueue,
    stateMachine,
    drafter,
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

  followUpEngine.start();

  // Re-enqueue any threads that still need classification (e.g. from a prior crash).
  for (const thread of threadsRepo.findNeedsClassification()) {
    const latest = messagesRepo.latestInboundForThread(thread.id);
    if (latest) classificationQueue.enqueue(latest.id);
  }

  // Graceful shutdown: close the server (flushes in-flight responses) and the DB
  // (checkpoints WAL) so a tray Quit / Electron kill doesn't leave -wal/-shm behind.
  let shuttingDown = false;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      log.info({ sig }, 'shutting down');
      followUpEngine.stop();
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
