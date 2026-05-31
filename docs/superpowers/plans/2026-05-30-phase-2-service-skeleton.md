# Phase 2 — Service Skeleton + DB + LLM Client — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the principal-side `apps/service` skeleton — Electron tray shell, Fastify HTTPS server, SQLCipher database, encrypted gateway client, first-run detection, and the auth/settings/push/SSE plumbing the PWA (Phase 2.5) will consume — runnable and testable on Windows.

**Architecture:** A headless server core (`server/`) that runs in plain Node for dev and tests, plus a thin Electron tray (`electron/`) that forks and supervises that same server when packaged. The server core depends only on injected interfaces (a `SecretStore`, the DB handle, a `GatewayClient`), so every unit is unit/integration-testable without Electron, real certs, or a real keychain.

**Tech Stack:** TypeScript (ESM, NodeNext, strict), Fastify 5 + @fastify/cors, `better-sqlite3-multiple-ciphers` (SQLCipher), `@napi-rs/keyring`, `pino`, `zod`, Electron 33, vitest, tsx. Reuses `@secretary/shared-crypto`, `@secretary/llm-protocol`, `@secretary/shared-types`.

**Spec:** `docs/superpowers/specs/2026-05-30-phase-2-service-skeleton-design.md`

---

## Conventions (apply to every task)

- ESM everywhere: local imports use the `.js` extension (e.g. `import { loadConfig } from './config.js'`).
- `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are on. Never assign `undefined` to an optional property — use conditional spreads. Array/index access yields `T | undefined`; narrow before use.
- Errors thrown are `SecretaryError` subclasses from `@secretary/shared-types`.
- API success → `{ data }`; failure → `{ error: { code, message } }`.
- Tests live in `apps/service/test/**/*.test.ts` and use vitest. Run a single file with `pnpm --filter @secretary/service exec vitest run test/<file>.test.ts`.
- Conventional commits. Commit after each task's tests pass.
- Working directory for all commands: repo root `C:\Users\drice\Secretary` unless stated.

## File responsibility map

| File                                                               | Responsibility                                  |
| ------------------------------------------------------------------ | ----------------------------------------------- |
| `apps/service/package.json` / `tsconfig.json` / `vitest.config.ts` | Package scaffold + scripts                      |
| `apps/service/scripts/set-secret.ts`                               | Dev utility to write a secret into the keychain |
| `server/auth/SecretStore.ts`                                       | `SecretStore` interface + `InMemorySecretStore` |
| `server/auth/KeychainStore.ts`                                     | `SecretStore` impl over `@napi-rs/keyring`      |
| `server/config.ts`                                                 | zod env schema → `Config`                       |
| `server/logger.ts`                                                 | pino logger factory (metadata only)             |
| `server/db/migrate.ts`                                             | Migration runner (`_migrations` table)          |
| `server/db/migrations/0001_init.sql`                               | All §6 tables + indexes                         |
| `server/db/schema.ts`                                              | Row types for all tables                        |
| `server/db/seed.ts`                                                | Idempotent settings defaults                    |
| `server/db/connection.ts`                                          | Open SQLCipher w/ keychain key, migrate + seed  |
| `server/db/repositories/SettingsRepository.ts`                     | Typed settings access                           |
| `server/db/repositories/PushSubscriptionRepository.ts`             | Push subscription rows                          |
| `server/llm/GatewayClient.ts`                                      | Encrypted gateway round-trip                    |
| `server/crypto/SessionTokens.ts`                                   | Bootstrap + HMAC session tokens                 |
| `server/eventBus.ts`                                               | In-process event emitter for SSE                |
| `server/api/*.ts`                                                  | Route groups (health/auth/settings/push/events) |
| `server/server.ts`                                                 | `buildServer(deps)` Fastify factory             |
| `server/httpsOptions.ts`                                           | Load cert/key from config paths                 |
| `server/setup/firstRun.ts`                                         | Setup detection + needs-setup flag              |
| `server/index.ts`                                                  | Headless entrypoint (Node or Electron child)    |
| `apps/service/pwa/index.html`                                      | Placeholder page                                |
| `electron/server-process.ts`                                       | Fork + supervise server child                   |
| `electron/tray-menu.ts`                                            | Tray menu construction                          |
| `electron/main.ts`                                                 | Electron tray app                               |
| `infra/mkcert/setup-certs.ps1`                                     | Generate dev HTTPS certs                        |

---

## Task 1: Scaffold the `apps/service` package and verify native modules load

**Files:**

- Create: `apps/service/package.json`
- Create: `apps/service/tsconfig.json`
- Create: `apps/service/vitest.config.ts`
- Create: `apps/service/test/smoke.test.ts`

- [ ] **Step 1: Create `apps/service/package.json`**

```json
{
  "name": "@secretary/service",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/server/index.js",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "dev:server": "tsx watch server/index.ts",
    "dev": "electron .",
    "set-secret": "tsx scripts/set-secret.ts",
    "rebuild:electron": "electron-rebuild -f -w better-sqlite3-multiple-ciphers",
    "clean": "rm -rf dist .tsbuildinfo coverage"
  },
  "dependencies": {
    "@fastify/cors": "^10.0.1",
    "@napi-rs/keyring": "^1.1.7",
    "@secretary/llm-protocol": "workspace:*",
    "@secretary/shared-crypto": "workspace:*",
    "@secretary/shared-types": "workspace:*",
    "better-sqlite3-multiple-ciphers": "^11.5.0",
    "fastify": "^5.1.0",
    "pino": "^9.5.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@electron/rebuild": "^3.7.0",
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^20.16.0",
    "@vitest/coverage-v8": "^2.1.0",
    "electron": "^33.2.0",
    "pino-pretty": "^11.2.2",
    "tsx": "^4.19.0",
    "typescript": "^5.6.3",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `apps/service/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["node"],
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["server/**/*", "electron/**/*", "scripts/**/*", "test/**/*"],
  "exclude": ["dist", "node_modules", "pwa"]
}
```

- [ ] **Step 3: Create `apps/service/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['server/**/*.ts'],
      exclude: ['server/index.ts'],
      thresholds: { statements: 60, branches: 60, functions: 60, lines: 60 },
    },
  },
});
```

- [ ] **Step 4: Create `apps/service/test/smoke.test.ts`** (proves the native SQLite module loads under plain Node)

```ts
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3-multiple-ciphers';

describe('native module smoke test', () => {
  it('loads better-sqlite3-multiple-ciphers and runs a query', () => {
    const db = new Database(':memory:');
    const row = db.prepare('SELECT 1 AS n').get() as { n: number };
    db.close();
    expect(row.n).toBe(1);
  });
});
```

- [ ] **Step 5: Install dependencies**

Run: `pnpm install`
Expected: completes without error; `better-sqlite3-multiple-ciphers` and `@napi-rs/keyring` install prebuilt binaries.

- [ ] **Step 6: Run the smoke test**

Run: `pnpm --filter @secretary/service test`
Expected: PASS (1 test). If this fails to load the native module, stop and resolve toolchain before continuing (this is the flagged Windows native-module risk; the plain-Node path must work first).

- [ ] **Step 7: Commit**

```bash
git add apps/service/package.json apps/service/tsconfig.json apps/service/vitest.config.ts apps/service/test/smoke.test.ts pnpm-lock.yaml
git commit -m "chore(service): scaffold apps/service package and verify native sqlite loads"
```

---

## Task 2: SecretStore interface, in-memory impl, keychain impl, dev set-secret script

**Files:**

- Create: `apps/service/server/auth/SecretStore.ts`
- Create: `apps/service/server/auth/KeychainStore.ts`
- Create: `apps/service/scripts/set-secret.ts`
- Test: `apps/service/test/secret-store.test.ts`

- [ ] **Step 1: Write the failing test** — `apps/service/test/secret-store.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { InMemorySecretStore } from '../server/auth/SecretStore.js';

describe('InMemorySecretStore', () => {
  it('returns null for an unknown key and false from has()', () => {
    const store = new InMemorySecretStore();
    expect(store.get('app.db-key')).toBeNull();
    expect(store.has('app.db-key')).toBe(false);
  });

  it('stores, reads, and deletes a secret', () => {
    const store = new InMemorySecretStore();
    store.set('app.db-key', 'abc123');
    expect(store.get('app.db-key')).toBe('abc123');
    expect(store.has('app.db-key')).toBe(true);
    store.delete('app.db-key');
    expect(store.get('app.db-key')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @secretary/service exec vitest run test/secret-store.test.ts`
Expected: FAIL — cannot find module `../server/auth/SecretStore.js`.

- [ ] **Step 3: Create `apps/service/server/auth/SecretStore.ts`**

```ts
/** Abstraction over OS secret storage. Consumers depend on this, not the keychain directly. */
export interface SecretStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
  has(key: string): boolean;
}

/** In-memory store for tests and headless dev runs. */
export class InMemorySecretStore implements SecretStore {
  private readonly map = new Map<string, string>();

  get(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.map.set(key, value);
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  has(key: string): boolean {
    return this.map.has(key);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @secretary/service exec vitest run test/secret-store.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Create `apps/service/server/auth/KeychainStore.ts`** (thin OS adapter; manually verified, not unit-tested against the real keychain)

```ts
import { Entry } from '@napi-rs/keyring';
import type { SecretStore } from './SecretStore.js';

const SERVICE_NAME = 'secretary';

/**
 * SecretStore backed by the OS keychain via @napi-rs/keyring.
 * Windows Credential Manager / macOS Keychain are selected transparently by the library.
 * `key` is the account name under the single "secretary" service, e.g. "app.db-key".
 */
export class KeychainStore implements SecretStore {
  private entry(key: string): Entry {
    return new Entry(SERVICE_NAME, key);
  }

  get(key: string): string | null {
    try {
      return this.entry(key).getPassword();
    } catch {
      return null;
    }
  }

  set(key: string, value: string): void {
    this.entry(key).setPassword(value);
  }

  delete(key: string): void {
    try {
      this.entry(key).deletePassword();
    } catch {
      /* already absent */
    }
  }

  has(key: string): boolean {
    return this.get(key) !== null;
  }
}
```

- [ ] **Step 6: Create `apps/service/scripts/set-secret.ts`** (dev utility to populate the keychain for manual testing)

```ts
import { KeychainStore } from '../server/auth/KeychainStore.js';

const [key, value] = process.argv.slice(2);
if (!key || !value) {
  console.error('Usage: pnpm --filter @secretary/service set-secret <key> <value>');
  process.exit(1);
}
new KeychainStore().set(key, value);
console.log(`Stored secret under key "${key}".`);
```

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @secretary/service typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/service/server/auth apps/service/scripts/set-secret.ts apps/service/test/secret-store.test.ts
git commit -m "feat(service): add SecretStore interface, keychain + in-memory impls, set-secret dev script"
```

---

## Task 3: config.ts

**Files:**

- Create: `apps/service/server/config.ts`
- Test: `apps/service/test/config.test.ts`

- [ ] **Step 1: Write the failing test** — `apps/service/test/config.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../server/config.js';

describe('loadConfig', () => {
  it('applies local-direct defaults when env is empty', () => {
    const c = loadConfig({});
    expect(c.port).toBe(47824);
    expect(c.gatewayUrl).toBe('http://localhost:47823');
    expect(c.gatewayUseCfHeaders).toBe(false);
  });

  it('coerces port and parses the CF-headers flag', () => {
    const c = loadConfig({ SERVICE_PORT: '5000', GATEWAY_USE_CF_HEADERS: 'true' });
    expect(c.port).toBe(5000);
    expect(c.gatewayUseCfHeaders).toBe(true);
  });

  it('throws a descriptive error on an invalid port', () => {
    expect(() => loadConfig({ SERVICE_PORT: 'abc' })).toThrow(/Invalid service config/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @secretary/service exec vitest run test/config.test.ts`
Expected: FAIL — cannot find module `../server/config.js`.

- [ ] **Step 3: Create `apps/service/server/config.ts`**

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const boolFlag = z
  .union([z.literal('true'), z.literal('false'), z.literal('1'), z.literal('0')])
  .transform((v) => v === 'true' || v === '1');

const defaultDataDir = join(homedir(), '.secretary');

const envSchema = z.object({
  SERVICE_PORT: z.coerce.number().int().positive().default(47824),
  SERVICE_HOST: z.string().default('127.0.0.1'),
  SERVICE_DATA_DIR: z.string().default(defaultDataDir),
  SERVICE_CERT_PATH: z.string().optional(),
  SERVICE_KEY_PATH: z.string().optional(),
  GATEWAY_URL: z.string().url().default('http://localhost:47823'),
  GATEWAY_USE_CF_HEADERS: boolFlag.default('false'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: boolFlag.default('false'),
});

export type LogLevel = z.infer<typeof envSchema>['LOG_LEVEL'];

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  certPath: string;
  keyPath: string;
  gatewayUrl: string;
  gatewayUseCfHeaders: boolean;
  logLevel: LogLevel;
  logPretty: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid service config: ${issues}`);
  }
  const e = parsed.data;
  return {
    port: e.SERVICE_PORT,
    host: e.SERVICE_HOST,
    dataDir: e.SERVICE_DATA_DIR,
    certPath: e.SERVICE_CERT_PATH ?? join(e.SERVICE_DATA_DIR, 'certs', 'localhost.pem'),
    keyPath: e.SERVICE_KEY_PATH ?? join(e.SERVICE_DATA_DIR, 'certs', 'localhost-key.pem'),
    gatewayUrl: e.GATEWAY_URL,
    gatewayUseCfHeaders: e.GATEWAY_USE_CF_HEADERS,
    logLevel: e.LOG_LEVEL,
    logPretty: e.LOG_PRETTY,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @secretary/service exec vitest run test/config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/service/server/config.ts apps/service/test/config.test.ts
git commit -m "feat(service): add config loader with local-direct gateway defaults"
```

---

## Task 4: logger.ts

**Files:**

- Create: `apps/service/server/logger.ts`
- Test: `apps/service/test/logger.test.ts`

- [ ] **Step 1: Write the failing test** — `apps/service/test/logger.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { createLogger } from '../server/logger.js';

describe('createLogger', () => {
  it('creates a logger at the requested level', () => {
    const log = createLogger({ level: 'warn', pretty: false });
    expect(log.level).toBe('warn');
    expect(typeof log.info).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @secretary/service exec vitest run test/logger.test.ts`
Expected: FAIL — cannot find module `../server/logger.js`.

- [ ] **Step 3: Create `apps/service/server/logger.ts`**

```ts
import pino, { type Logger } from 'pino';

export interface LoggerOptions {
  level: string;
  pretty: boolean;
  /** When set, logs are written to this file instead of stdout. */
  filePath?: string;
}

/**
 * Creates the service logger. Logs metadata only — never message bodies,
 * prompts, completions, or secret values. Callers must not pass such fields.
 */
export function createLogger(opts: LoggerOptions): Logger {
  if (opts.pretty) {
    return pino({
      level: opts.level,
      transport: { target: 'pino-pretty', options: { colorize: true } },
    });
  }
  if (opts.filePath) {
    return pino(
      { level: opts.level },
      pino.destination({ dest: opts.filePath, mkdir: true, sync: false }),
    );
  }
  return pino({ level: opts.level });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @secretary/service exec vitest run test/logger.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add apps/service/server/logger.ts apps/service/test/logger.test.ts
git commit -m "feat(service): add pino logger factory (metadata-only)"
```

---

## Task 5: Migration runner

**Files:**

- Create: `apps/service/server/db/migrate.ts`
- Test: `apps/service/test/migrate.test.ts`

- [ ] **Step 1: Write the failing test** — `apps/service/test/migrate.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3-multiple-ciphers';
import { runMigrations } from '../server/db/migrate.js';

const M1 = {
  version: 1,
  name: 'create_widgets',
  sql: 'CREATE TABLE widgets (id INTEGER PRIMARY KEY);',
};

describe('runMigrations', () => {
  it('applies pending migrations and records them', () => {
    const db = new Database(':memory:');
    const applied = runMigrations(db, [M1]);
    expect(applied).toEqual([1]);
    const row = db.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number };
    expect(row.n).toBe(1);
  });

  it('is idempotent — running again applies nothing', () => {
    const db = new Database(':memory:');
    runMigrations(db, [M1]);
    const second = runMigrations(db, [M1]);
    expect(second).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @secretary/service exec vitest run test/migrate.test.ts`
Expected: FAIL — cannot find module `../server/db/migrate.js`.

- [ ] **Step 3: Create `apps/service/server/db/migrate.ts`**

```ts
import type { Database } from 'better-sqlite3-multiple-ciphers';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Applies any migrations whose version is greater than the highest applied version.
 * Each migration runs inside a transaction. Returns the versions applied this run.
 */
export function runMigrations(db: Database, migrations: Migration[]): number[] {
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
       version INTEGER PRIMARY KEY,
       name TEXT NOT NULL,
       applied_at INTEGER NOT NULL
     );`,
  );
  const current =
    (db.prepare('SELECT MAX(version) AS v FROM _migrations').get() as { v: number | null }).v ?? 0;

  const pending = migrations
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version);

  const record = db.prepare('INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)');
  const applied: number[] = [];
  for (const m of pending) {
    const apply = db.transaction(() => {
      db.exec(m.sql);
      record.run(m.version, m.name, Date.now());
    });
    apply();
    applied.push(m.version);
  }
  return applied;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @secretary/service exec vitest run test/migrate.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/service/server/db/migrate.ts apps/service/test/migrate.test.ts
git commit -m "feat(service): add sqlite migration runner with _migrations tracking"
```

---

## Task 6: Initial migration (all §6 tables) + schema types + migration registry

**Files:**

- Create: `apps/service/server/db/migrations/0001_init.sql`
- Create: `apps/service/server/db/migrations/index.ts`
- Create: `apps/service/server/db/schema.ts`
- Test: `apps/service/test/schema-migration.test.ts`

- [ ] **Step 1: Write the failing test** — `apps/service/test/schema-migration.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3-multiple-ciphers';
import { runMigrations } from '../server/db/migrate.js';
import { migrations } from '../server/db/migrations/index.js';

const TABLES = [
  'accounts',
  'messages',
  'threads',
  'contacts',
  'drafts',
  'follow_ups',
  'action_log',
  'settings',
  'push_subscriptions',
  'style_examples',
];

describe('0001_init migration', () => {
  it('creates every table from the brief schema', () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name);
    for (const t of TABLES) expect(names).toContain(t);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @secretary/service exec vitest run test/schema-migration.test.ts`
Expected: FAIL — cannot find module `../server/db/migrations/index.js`.

- [ ] **Step 3: Create `apps/service/server/db/migrations/0001_init.sql`** (verbatim from BRIEF §6)

```sql
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('imap','gmail','graph')),
  display_name TEXT NOT NULL,
  email_address TEXT NOT NULL,
  imap_host TEXT,
  imap_port INTEGER,
  imap_use_tls INTEGER,
  smtp_host TEXT,
  smtp_port INTEGER,
  oauth_keychain_handle TEXT,
  imap_password_keychain_handle TEXT,
  sync_state TEXT,
  is_enabled INTEGER DEFAULT 1,
  created_at INTEGER,
  last_synced_at INTEGER
);

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider_thread_id TEXT,
  subject_normalized TEXT,
  participants TEXT,
  message_count INTEGER DEFAULT 0,
  first_message_at INTEGER,
  last_message_at INTEGER,
  last_inbound_at INTEGER,
  last_outbound_at INTEGER,
  state TEXT NOT NULL DEFAULT 'needs_classification'
    CHECK (state IN ('needs_classification','awaiting_their_reply','awaiting_your_reply','closed','scheduled_followup','informational')),
  state_changed_at INTEGER,
  state_reason TEXT,
  sla_deadline INTEGER,
  urgency TEXT CHECK (urgency IN ('low','normal','high')),
  last_agent_summary TEXT,
  is_archived INTEGER DEFAULT 0
);
CREATE INDEX idx_threads_state_sla ON threads (state, sla_deadline);
CREATE INDEX idx_threads_last_inbound ON threads (last_inbound_at DESC);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  message_id_header TEXT,
  in_reply_to TEXT,
  references_header TEXT,
  from_address TEXT NOT NULL,
  from_name TEXT,
  to_addresses TEXT,
  cc_addresses TEXT,
  bcc_addresses TEXT,
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  snippet TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  date_sent INTEGER,
  date_received INTEGER,
  is_read INTEGER,
  is_starred INTEGER,
  is_draft INTEGER,
  folder TEXT,
  labels TEXT,
  attachments_meta TEXT,
  raw_size_bytes INTEGER,
  synced_at INTEGER,
  UNIQUE (account_id, provider_id)
);
CREATE INDEX idx_messages_thread ON messages (thread_id, date_received);
CREATE INDEX idx_messages_account_date ON messages (account_id, date_received DESC);
CREATE INDEX idx_messages_from ON messages (from_address);
CREATE INDEX idx_messages_msgid ON messages (message_id_header);

CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  email_address TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT,
  aliases TEXT,
  category TEXT NOT NULL DEFAULT 'unknown'
    CHECK (category IN ('client_established','client_new','screening','personal','vendor','noise','unknown')),
  notes TEXT,
  first_contact_at INTEGER,
  last_contact_at INTEGER,
  total_messages_in INTEGER DEFAULT 0,
  total_messages_out INTEGER DEFAULT 0,
  style_notes TEXT,
  do_not_auto_draft INTEGER DEFAULT 0,
  screening_status TEXT
    CHECK (screening_status IN ('never_screened','screening_in_progress','cleared','rejected') OR screening_status IS NULL),
  booking_history TEXT
);
CREATE INDEX idx_contacts_category ON contacts (category);
CREATE INDEX idx_contacts_last_contact ON contacts (last_contact_at DESC);

CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  in_reply_to_message_id TEXT REFERENCES messages(id),
  to_addresses TEXT,
  cc_addresses TEXT,
  subject TEXT,
  body_text TEXT NOT NULL,
  body_html TEXT,
  raw_intent TEXT,
  polish_diff TEXT,
  system_prompt_used TEXT,
  model_used TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  latency_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review','editing','sent','discarded','failed')),
  created_at INTEGER,
  sent_at INTEGER,
  final_body_sent TEXT
);
CREATE INDEX idx_drafts_thread_version ON drafts (thread_id, version);
CREATE INDEX idx_drafts_status_created ON drafts (status, created_at);

CREATE TABLE follow_ups (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  trigger_at INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('sla_breach','scheduled_reminder','awaiting_response','manual_pin')),
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','surfaced','dismissed','resolved')),
  created_at INTEGER,
  surfaced_at INTEGER,
  resolved_at INTEGER
);
CREATE INDEX idx_followups_status_trigger ON follow_ups (status, trigger_at);

CREATE TABLE action_log (
  id TEXT PRIMARY KEY,
  timestamp INTEGER NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('agent','user','system')),
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  details TEXT
);
CREATE INDEX idx_action_log_time ON action_log (timestamp DESC);
CREATE INDEX idx_action_log_target ON action_log (target_type, target_id);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER
);

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  keys_p256dh TEXT NOT NULL,
  keys_auth TEXT NOT NULL,
  user_agent TEXT,
  created_at INTEGER,
  last_used_at INTEGER
);

CREATE TABLE style_examples (
  id TEXT PRIMARY KEY,
  source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  contact_category TEXT,
  context_summary TEXT,
  reply_text TEXT,
  tags TEXT,
  embedding BLOB
);
CREATE INDEX idx_style_examples_category ON style_examples (contact_category);
```

- [ ] **Step 4: Create `apps/service/server/db/migrations/index.ts`** (loads SQL files at runtime, ordered by version)

```ts
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Migration } from '../migrate.js';

const here = dirname(fileURLToPath(import.meta.url));

function load(version: number, name: string): Migration {
  const file = `${String(version).padStart(4, '0')}_${name}.sql`;
  return { version, name, sql: readFileSync(join(here, file), 'utf8') };
}

export const migrations: Migration[] = [load(1, 'init')];
```

- [ ] **Step 5: Create `apps/service/server/db/schema.ts`** (row types; integers-as-booleans noted)

```ts
/** Row types mirror the SQLite schema. Booleans are stored as INTEGER 0/1. */
export interface AccountRow {
  id: string;
  provider: 'imap' | 'gmail' | 'graph';
  display_name: string;
  email_address: string;
  imap_host: string | null;
  imap_port: number | null;
  imap_use_tls: number | null;
  smtp_host: string | null;
  smtp_port: number | null;
  oauth_keychain_handle: string | null;
  imap_password_keychain_handle: string | null;
  sync_state: string | null;
  is_enabled: number;
  created_at: number | null;
  last_synced_at: number | null;
}

export interface SettingRow {
  key: string;
  value: string | null;
  updated_at: number | null;
}

export interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  keys_p256dh: string;
  keys_auth: string;
  user_agent: string | null;
  created_at: number | null;
  last_used_at: number | null;
}

/**
 * Remaining table row types (threads, messages, contacts, drafts, follow_ups,
 * action_log, style_examples) are added in the phases whose repositories consume
 * them (Phases 3–6), to avoid unused declarations now.
 */
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @secretary/service exec vitest run test/schema-migration.test.ts`
Expected: PASS (1 test, all tables present).

- [ ] **Step 7: Confirm SQL is bundled for the built output**

The migration loader reads `.sql` at runtime relative to the compiled file. Add a copy step so `dist` contains the SQL. Modify `apps/service/package.json` `build` script:

```json
"build": "tsc -p tsconfig.json && node -e \"require('node:fs').cpSync('server/db/migrations','dist/server/db/migrations',{recursive:true,filter:(s)=>!s.endsWith('.ts')})\"",
```

Run: `pnpm --filter @secretary/service build`
Expected: `dist/server/db/migrations/0001_init.sql` exists.

- [ ] **Step 8: Commit**

```bash
git add apps/service/server/db/migrations apps/service/server/db/schema.ts apps/service/test/schema-migration.test.ts apps/service/package.json
git commit -m "feat(service): add 0001 init migration with all brief tables and row types"
```

---

## Task 7: connection.ts (SQLCipher open + key management) and seed.ts

**Files:**

- Create: `apps/service/server/db/seed.ts`
- Create: `apps/service/server/db/connection.ts`
- Test: `apps/service/test/connection.test.ts`

- [ ] **Step 1: Write the failing test** — `apps/service/test/connection.test.ts`

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3-multiple-ciphers';
import { InMemorySecretStore } from '../server/auth/SecretStore.js';
import { openDatabase, DB_KEY_SECRET } from '../server/db/connection.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secretary-db-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('openDatabase', () => {
  it('generates and stores a db key on first run, applies migrations and seeds', () => {
    const store = new InMemorySecretStore();
    const db = openDatabase(join(dir, 'secretary.db'), store);
    expect(store.has(DB_KEY_SECRET)).toBe(true);
    const settings = db.prepare('SELECT COUNT(*) AS n FROM settings').get() as { n: number };
    expect(settings.n).toBeGreaterThan(0);
    db.close();
  });

  it('fails to read the encrypted file with a wrong key', () => {
    const store = new InMemorySecretStore();
    const dbPath = join(dir, 'secretary.db');
    openDatabase(dbPath, store).close();

    const wrong = new Database(dbPath);
    wrong.pragma(`key='${'0'.repeat(64)}'`);
    expect(() => wrong.prepare('SELECT COUNT(*) FROM settings').get()).toThrow();
    wrong.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @secretary/service exec vitest run test/connection.test.ts`
Expected: FAIL — cannot find module `../server/db/connection.js`.

- [ ] **Step 3: Create `apps/service/server/db/seed.ts`**

```ts
import type { Database } from 'better-sqlite3-multiple-ciphers';

/** Default settings from BRIEF §6. Stored as JSON strings in the `value` column. */
const DEFAULTS: Record<string, unknown> = {
  'agent.classify_on_inbound': true,
  'agent.autodraft_on_inbound': true,
  'agent.poll_interval_seconds': 60,
  'agent.sla.client_established.awaiting_your_reply_hours': 12,
  'agent.sla.client_new.awaiting_your_reply_hours': 4,
  'agent.sla.default.awaiting_their_reply_hours': 72,
  'llm.model': 'qwen2.5:14b-instruct-q5_K_M',
  'llm.temperature.classify': 0.1,
  'llm.temperature.draft': 0.5,
  'notifications.web_push_enabled': false,
};

/** Inserts default settings without overwriting existing keys. Idempotent. */
export function seedSettings(db: Database): void {
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
  );
  const now = Date.now();
  const tx = db.transaction(() => {
    for (const [key, value] of Object.entries(DEFAULTS)) {
      stmt.run(key, JSON.stringify(value), now);
    }
  });
  tx();
}
```

- [ ] **Step 4: Create `apps/service/server/db/connection.ts`**

```ts
import { randomBytes } from 'node:crypto';
import Database, { type Database as DB } from 'better-sqlite3-multiple-ciphers';
import type { SecretStore } from '../auth/SecretStore.js';
import { runMigrations } from './migrate.js';
import { migrations } from './migrations/index.js';
import { seedSettings } from './seed.js';

export const DB_KEY_SECRET = 'app.db-key';

/** Returns the SQLCipher key, generating + persisting a 32-byte hex key on first run. */
function resolveDbKey(store: SecretStore): string {
  const existing = store.get(DB_KEY_SECRET);
  if (existing) return existing;
  const key = randomBytes(32).toString('hex');
  store.set(DB_KEY_SECRET, key);
  return key;
}

/**
 * Opens (creating if needed) the encrypted database, applies migrations, seeds
 * default settings, and enables foreign keys. The key comes from the SecretStore.
 */
export function openDatabase(path: string, store: SecretStore): DB {
  const key = resolveDbKey(store);
  const db = new Database(path);
  db.pragma(`key='${key}'`);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  seedSettings(db);
  return db;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @secretary/service exec vitest run test/connection.test.ts`
Expected: PASS (2 tests — first-run keygen + seed, and wrong-key open fails).

- [ ] **Step 6: Commit**

```bash
git add apps/service/server/db/connection.ts apps/service/server/db/seed.ts apps/service/test/connection.test.ts
git commit -m "feat(service): open SQLCipher db with keychain key, run migrations, seed settings"
```

---

## Task 8: SettingsRepository

**Files:**

- Create: `apps/service/server/db/repositories/SettingsRepository.ts`
- Test: `apps/service/test/settings-repository.test.ts`

- [ ] **Step 1: Write the failing test** — `apps/service/test/settings-repository.test.ts`

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemorySecretStore } from '../server/auth/SecretStore.js';
import { openDatabase } from '../server/db/connection.js';
import { SettingsRepository } from '../server/db/repositories/SettingsRepository.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secretary-settings-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function repo() {
  const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
  return new SettingsRepository(db);
}

describe('SettingsRepository', () => {
  it('reads a seeded default as its parsed JSON value', () => {
    expect(repo().get('agent.poll_interval_seconds')).toBe(60);
  });

  it('getAll returns an object keyed by setting name', () => {
    const all = repo().getAll();
    expect(all['llm.model']).toBe('qwen2.5:14b-instruct-q5_K_M');
  });

  it('patch upserts multiple keys and returns the merged view', () => {
    const r = repo();
    const merged = r.patch({ 'agent.poll_interval_seconds': 30, 'llm.temperature.draft': 0.7 });
    expect(merged['agent.poll_interval_seconds']).toBe(30);
    expect(r.get('llm.temperature.draft')).toBe(0.7);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @secretary/service exec vitest run test/settings-repository.test.ts`
Expected: FAIL — cannot find module `SettingsRepository.js`.

- [ ] **Step 3: Create `apps/service/server/db/repositories/SettingsRepository.ts`**

```ts
import type { Database } from 'better-sqlite3-multiple-ciphers';
import type { SettingRow } from '../schema.js';

export class SettingsRepository {
  constructor(private readonly db: Database) {}

  get<T = unknown>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | Pick<SettingRow, 'value'>
      | undefined;
    if (!row || row.value === null) return undefined;
    return JSON.parse(row.value) as T;
  }

  getAll(): Record<string, unknown> {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as Pick<
      SettingRow,
      'key' | 'value'
    >[];
    const out: Record<string, unknown> = {};
    for (const r of rows) out[r.key] = r.value === null ? null : JSON.parse(r.value);
    return out;
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), Date.now());
  }

  /** Upserts every key in the partial object, then returns the full merged settings view. */
  patch(partial: Record<string, unknown>): Record<string, unknown> {
    const tx = this.db.transaction(() => {
      for (const [key, value] of Object.entries(partial)) this.set(key, value);
    });
    tx();
    return this.getAll();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @secretary/service exec vitest run test/settings-repository.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/service/server/db/repositories/SettingsRepository.ts apps/service/test/settings-repository.test.ts
git commit -m "feat(service): add SettingsRepository with JSON get/getAll/set/patch"
```

---

## Task 9: PushSubscriptionRepository

**Files:**

- Create: `apps/service/server/db/repositories/PushSubscriptionRepository.ts`
- Test: `apps/service/test/push-repository.test.ts`

- [ ] **Step 1: Write the failing test** — `apps/service/test/push-repository.test.ts`

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemorySecretStore } from '../server/auth/SecretStore.js';
import { openDatabase } from '../server/db/connection.js';
import { PushSubscriptionRepository } from '../server/db/repositories/PushSubscriptionRepository.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secretary-push-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function repo() {
  const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
  return new PushSubscriptionRepository(db);
}

const SUB = {
  endpoint: 'https://push.example/abc',
  keys: { p256dh: 'p256dh-value', auth: 'auth-value' },
  userAgent: 'test-agent',
};

describe('PushSubscriptionRepository', () => {
  it('upserts by endpoint (no duplicates) and lists subscriptions', () => {
    const r = repo();
    r.upsert(SUB);
    r.upsert(SUB);
    const list = r.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.endpoint).toBe(SUB.endpoint);
  });

  it('deletes by endpoint', () => {
    const r = repo();
    r.upsert(SUB);
    r.deleteByEndpoint(SUB.endpoint);
    expect(r.list()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @secretary/service exec vitest run test/push-repository.test.ts`
Expected: FAIL — cannot find module `PushSubscriptionRepository.js`.

- [ ] **Step 3: Create `apps/service/server/db/repositories/PushSubscriptionRepository.ts`**

```ts
import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3-multiple-ciphers';
import type { PushSubscriptionRow } from '../schema.js';

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
}

export class PushSubscriptionRepository {
  constructor(private readonly db: Database) {}

  /** Inserts a subscription, or refreshes keys/last_used_at if the endpoint already exists. */
  upsert(sub: PushSubscriptionInput): void {
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (id, endpoint, keys_p256dh, keys_auth, user_agent, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
           keys_p256dh = excluded.keys_p256dh,
           keys_auth = excluded.keys_auth,
           user_agent = excluded.user_agent,
           last_used_at = excluded.last_used_at`,
      )
      .run(
        randomUUID(),
        sub.endpoint,
        sub.keys.p256dh,
        sub.keys.auth,
        sub.userAgent ?? null,
        Date.now(),
        Date.now(),
      );
  }

  list(): PushSubscriptionRow[] {
    return this.db.prepare('SELECT * FROM push_subscriptions').all() as PushSubscriptionRow[];
  }

  deleteByEndpoint(endpoint: string): void {
    this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @secretary/service exec vitest run test/push-repository.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/service/server/db/repositories/PushSubscriptionRepository.ts apps/service/test/push-repository.test.ts
git commit -m "feat(service): add PushSubscriptionRepository (upsert/list/delete)"
```

---

## Task 10: GatewayClient + local fake-gateway integration test

**Files:**

- Create: `apps/service/server/llm/GatewayClient.ts`
- Test: `apps/service/test/gateway-client.test.ts`

- [ ] **Step 1: Write the failing test** — `apps/service/test/gateway-client.test.ts`

```ts
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  decryptJson,
  encryptJson,
  hexToKey,
  type EncryptedEnvelope,
} from '@secretary/shared-crypto';
import type { CompleteRequest, CompleteResponse } from '@secretary/llm-protocol';
import { ENVELOPE_CONTENT_TYPE } from '@secretary/llm-protocol';
import { createGatewayClient } from '../server/llm/GatewayClient.js';

const PAYLOAD_KEY = 'a'.repeat(64);
const API_KEY = 'b'.repeat(64);

/** A fake gateway that decrypts the request and returns an encrypted canned completion. */
function startFakeGateway(
  onApiKey: (k: string | undefined) => void,
): Promise<{ url: string; server: Server }> {
  const key = hexToKey(PAYLOAD_KEY);
  const server = createServer((req, res) => {
    onApiKey(req.headers['x-api-key'] as string | undefined);
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const envelope = JSON.parse(body) as EncryptedEnvelope;
      const decoded = decryptJson<CompleteRequest>(key, envelope);
      const response: CompleteResponse = {
        response: `echo:${decoded.prompt}`,
        model: decoded.model,
        tokens_in: 1,
        tokens_out: 2,
        duration_ms: 3,
      };
      res.writeHead(200, { 'content-type': ENVELOPE_CONTENT_TYPE });
      res.end(JSON.stringify(encryptJson(key, response)));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, server });
    });
  });
}

let server: Server | undefined;
afterEach(() => server?.close());

describe('GatewayClient', () => {
  it('encrypts the request, sends X-API-Key, and decrypts the response', async () => {
    let seenApiKey: string | undefined;
    const started = await startFakeGateway((k) => (seenApiKey = k));
    server = started.server;

    const client = createGatewayClient({
      gatewayUrl: started.url,
      useCfHeaders: false,
      apiKey: API_KEY,
      payloadKey: PAYLOAD_KEY,
    });
    const out = await client.complete({ model: 'm', prompt: 'hello' });

    expect(out.response).toBe('echo:hello');
    expect(seenApiKey).toBe(API_KEY);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @secretary/service exec vitest run test/gateway-client.test.ts`
Expected: FAIL — cannot find module `GatewayClient.js`.

- [ ] **Step 3: Create `apps/service/server/llm/GatewayClient.ts`**

```ts
import {
  decryptJson,
  encryptJson,
  hexToKey,
  type EncryptedEnvelope,
} from '@secretary/shared-crypto';
import {
  ENVELOPE_CONTENT_TYPE,
  completeResponseSchema,
  type CompleteRequest,
  type CompleteResponse,
} from '@secretary/llm-protocol';
import { UpstreamError } from '@secretary/shared-types';

export interface GatewayClientOptions {
  gatewayUrl: string;
  useCfHeaders: boolean;
  apiKey: string;
  /** 64-char hex payload encryption key. */
  payloadKey: string;
  cfClientId?: string;
  cfClientSecret?: string;
}

export interface GatewayClient {
  complete(req: CompleteRequest): Promise<CompleteResponse>;
}

export function createGatewayClient(opts: GatewayClientOptions): GatewayClient {
  const key = hexToKey(opts.payloadKey);
  const url = `${opts.gatewayUrl.replace(/\/$/, '')}/v1/complete`;

  const headers: Record<string, string> = {
    'content-type': ENVELOPE_CONTENT_TYPE,
    accept: ENVELOPE_CONTENT_TYPE,
    'x-api-key': opts.apiKey,
  };
  if (opts.useCfHeaders && opts.cfClientId && opts.cfClientSecret) {
    headers['CF-Access-Client-Id'] = opts.cfClientId;
    headers['CF-Access-Client-Secret'] = opts.cfClientSecret;
  }

  async function post(req: CompleteRequest): Promise<CompleteResponse> {
    const body = JSON.stringify(encryptJson(key, req));
    const res = await fetch(url, { method: 'POST', headers, body });
    if (!res.ok) {
      throw new UpstreamError('gateway_error', `Gateway returned ${res.status}`, 502);
    }
    const envelope = (await res.json()) as EncryptedEnvelope;
    const decoded = decryptJson<unknown>(key, envelope);
    return completeResponseSchema.parse(decoded);
  }

  return {
    async complete(req: CompleteRequest): Promise<CompleteResponse> {
      try {
        return await post(req);
      } catch (err) {
        if (err instanceof UpstreamError) throw err;
        // One retry on transient network/parse failure.
        return post(req);
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @secretary/service exec vitest run test/gateway-client.test.ts`
Expected: PASS (1 test — encrypted round-trip + API key header).

- [ ] **Step 5: Commit**

```bash
git add apps/service/server/llm/GatewayClient.ts apps/service/test/gateway-client.test.ts
git commit -m "feat(service): add encrypted GatewayClient with config-driven CF headers"
```

---

## Task 11: SessionTokens (bootstrap + HMAC session tokens)

**Files:**

- Create: `apps/service/server/crypto/SessionTokens.ts`
- Test: `apps/service/test/session-tokens.test.ts`

- [ ] **Step 1: Write the failing test** — `apps/service/test/session-tokens.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { InMemorySecretStore } from '../server/auth/SecretStore.js';
import { SessionTokens } from '../server/crypto/SessionTokens.js';

function make(now = () => 1_000) {
  return new SessionTokens(new InMemorySecretStore(), now);
}

describe('SessionTokens', () => {
  it('exchanges its bootstrap token once for a valid session token', () => {
    const st = make();
    const bootstrap = st.currentBootstrapToken();
    const { token } = st.exchangeBootstrap(bootstrap);
    expect(st.validateSession(token)).toBe(true);
    // single-use: second exchange of the same bootstrap token fails
    expect(() => st.exchangeBootstrap(bootstrap)).toThrow();
  });

  it('rejects an expired session token', () => {
    let t = 1_000;
    const st = new SessionTokens(new InMemorySecretStore(), () => t);
    const { token } = st.exchangeBootstrap(st.currentBootstrapToken(), 10);
    t = 20_000;
    expect(st.validateSession(token)).toBe(false);
  });

  it('revokeAll invalidates previously issued tokens', () => {
    const st = make();
    const { token } = st.exchangeBootstrap(st.currentBootstrapToken());
    expect(st.validateSession(token)).toBe(true);
    st.revokeAll();
    expect(st.validateSession(token)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @secretary/service exec vitest run test/session-tokens.test.ts`
Expected: FAIL — cannot find module `SessionTokens.js`.

- [ ] **Step 3: Create `apps/service/server/crypto/SessionTokens.ts`**

```ts
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AuthError } from '@secretary/shared-types';
import type { SecretStore } from '../auth/SecretStore.js';

const SIGNING_KEY_SECRET = 'app.session-signing-key';
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

/**
 * Issues stateless HMAC-signed session tokens. The signing key lives in the
 * SecretStore; revocation rotates it (invalidating all tokens). A one-time
 * bootstrap token is generated per instance for the initial PWA handshake.
 */
export class SessionTokens {
  private bootstrap: string | null;

  constructor(
    private readonly store: SecretStore,
    private readonly now: () => number = Date.now,
  ) {
    this.bootstrap = randomBytes(32).toString('hex');
  }

  private signingKey(): Buffer {
    let hex = this.store.get(SIGNING_KEY_SECRET);
    if (!hex) {
      hex = randomBytes(32).toString('hex');
      this.store.set(SIGNING_KEY_SECRET, hex);
    }
    return Buffer.from(hex, 'hex');
  }

  currentBootstrapToken(): string {
    if (!this.bootstrap) throw new AuthError('Bootstrap token already used');
    return this.bootstrap;
  }

  exchangeBootstrap(
    token: string,
    ttlSeconds = DEFAULT_TTL_SECONDS,
  ): { token: string; expiresAt: number } {
    if (!this.bootstrap) throw new AuthError('Bootstrap token already used');
    const a = Buffer.from(token);
    const b = Buffer.from(this.bootstrap);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new AuthError('Invalid bootstrap token');
    }
    this.bootstrap = null; // single-use
    return this.issueSession(ttlSeconds);
  }

  issueSession(ttlSeconds = DEFAULT_TTL_SECONDS): { token: string; expiresAt: number } {
    const expiresAt = this.now() + ttlSeconds * 1000;
    const payload = b64url(Buffer.from(JSON.stringify({ exp: expiresAt })));
    const sig = b64url(createHmac('sha256', this.signingKey()).update(payload).digest());
    return { token: `${payload}.${sig}`, expiresAt };
  }

  validateSession(token: string): boolean {
    const dot = token.indexOf('.');
    if (dot < 0) return false;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = b64url(createHmac('sha256', this.signingKey()).update(payload).digest());
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
    try {
      const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
        exp: number;
      };
      return typeof exp === 'number' && exp > this.now();
    } catch {
      return false;
    }
  }

  /** Rotates the signing key, invalidating every previously issued session token. */
  revokeAll(): void {
    this.store.set(SIGNING_KEY_SECRET, randomBytes(32).toString('hex'));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @secretary/service exec vitest run test/session-tokens.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/service/server/crypto/SessionTokens.ts apps/service/test/session-tokens.test.ts
git commit -m "feat(service): add bootstrap + HMAC session token issuance and validation"
```

---

## Task 12: eventBus + Fastify server factory (envelope, CORS, auth guard, health)

**Files:**

- Create: `apps/service/server/eventBus.ts`
- Create: `apps/service/server/server.ts`
- Test: `apps/service/test/server-core.test.ts`

This task defines the `ServerDeps` shape and `buildServer(deps)`. Later route tasks register their routes inside `buildServer` by adding calls; their tests reuse a shared `makeTestServer` helper created here.

- [ ] **Step 1: Write the failing test** — `apps/service/test/server-core.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { makeTestServer } from './helpers/testServer.js';

describe('server core', () => {
  it('serves unauthenticated health', async () => {
    const { app } = await makeTestServer();
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: { ok: true } });
    await app.close();
  });

  it('rejects an unauthenticated protected route with the error envelope', async () => {
    const { app } = await makeTestServer();
    const res = await app.inject({ method: 'GET', url: '/api/v1/settings' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
    await app.close();
  });
});
```

- [ ] **Step 2: Create the shared test helper** — `apps/service/test/helpers/testServer.ts`

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemorySecretStore } from '../../server/auth/SecretStore.js';
import { openDatabase } from '../../server/db/connection.js';
import { SessionTokens } from '../../server/crypto/SessionTokens.js';
import { EventBus } from '../../server/eventBus.js';
import { buildServer } from '../../server/server.js';

/** Builds a fully-wired server against a temp encrypted DB and an in-memory secret store. */
export async function makeTestServer() {
  const dir = mkdtempSync(join(tmpdir(), 'secretary-srv-'));
  const store = new InMemorySecretStore();
  const db = openDatabase(join(dir, 'secretary.db'), store);
  const sessions = new SessionTokens(store);
  const eventBus = new EventBus();
  const app = buildServer({ db, sessions, eventBus, origin: 'https://localhost:47824' });
  await app.ready();

  // Helper to obtain a valid bearer token for protected-route tests.
  const session = sessions.exchangeBootstrap(sessions.currentBootstrapToken()).token;
  return { app, store, db, sessions, eventBus, session };
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @secretary/service exec vitest run test/server-core.test.ts`
Expected: FAIL — cannot find module `../server/eventBus.js` / `../server/server.js`.

- [ ] **Step 4: Create `apps/service/server/eventBus.ts`**

```ts
import { EventEmitter } from 'node:events';

export type ServerEvent =
  | { type: 'thread:updated'; payload: unknown }
  | { type: 'draft:ready'; payload: unknown }
  | { type: 'account:status'; payload: unknown }
  | { type: 'sync:progress'; payload: unknown };

/** In-process pub/sub feeding the SSE endpoint. Domain events are emitted in later phases. */
export class EventBus {
  private readonly emitter = new EventEmitter();

  emit(event: ServerEvent): void {
    this.emitter.emit('event', event);
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
}
```

- [ ] **Step 5: Create `apps/service/server/server.ts`**

```ts
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3-multiple-ciphers';
import { SecretaryError } from '@secretary/shared-types';
import type { SessionTokens } from './crypto/SessionTokens.js';
import type { EventBus } from './eventBus.js';
import { registerHealthRoutes } from './api/health.js';

export interface ServerDeps {
  db: Database;
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
    if (PUBLIC_PATHS.has(req.url.split('?')[0] ?? req.url)) return;
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
```

- [ ] **Step 6: Create `apps/service/server/api/health.ts`**

```ts
import type { FastifyInstance } from 'fastify';

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/health', async () => ({ data: { ok: true } }));
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm --filter @secretary/service exec vitest run test/server-core.test.ts`
Expected: PASS (2 tests — health open, settings 401).

- [ ] **Step 8: Commit**

```bash
git add apps/service/server/eventBus.ts apps/service/server/server.ts apps/service/server/api/health.ts apps/service/test/server-core.test.ts apps/service/test/helpers/testServer.ts
git commit -m "feat(service): add Fastify server factory with CORS, auth guard, error envelope, health"
```

---

## Task 13: Auth routes (bootstrap→session exchange, revoke)

**Files:**

- Create: `apps/service/server/api/auth.ts`
- Modify: `apps/service/server/server.ts` (register the routes)
- Test: `apps/service/test/auth-routes.test.ts`

- [ ] **Step 1: Write the failing test** — `apps/service/test/auth-routes.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { makeTestServer } from './helpers/testServer.js';

describe('auth routes', () => {
  it('exchanges the bootstrap token for a session token', async () => {
    const { app, sessions } = await makeTestServer();
    // makeTestServer already consumed the first bootstrap token; issue a fresh instance path:
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/session',
      payload: { bootstrapToken: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
    void sessions;
    await app.close();
  });

  it('issues a usable session for a valid bootstrap token', async () => {
    const { app } = await makeTestServer({ consumeBootstrap: false });
    const boot = (await app.inject({ method: 'GET', url: '/api/v1/health' })).statusCode; // warmup
    void boot;
    const bootstrapToken = (app as unknown as { __bootstrap: string }).__bootstrap;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/session',
      payload: { bootstrapToken },
    });
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().data.token).toBe('string');
    await app.close();
  });
});
```

> Note: update `makeTestServer` to accept `{ consumeBootstrap?: boolean }` (default true) and to expose the bootstrap token. Apply Step 2 before running.

- [ ] **Step 2: Update `apps/service/test/helpers/testServer.ts`**

Replace the helper body with:

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemorySecretStore } from '../../server/auth/SecretStore.js';
import { openDatabase } from '../../server/db/connection.js';
import { SessionTokens } from '../../server/crypto/SessionTokens.js';
import { EventBus } from '../../server/eventBus.js';
import { buildServer } from '../../server/server.js';

export async function makeTestServer(opts: { consumeBootstrap?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'secretary-srv-'));
  const store = new InMemorySecretStore();
  const db = openDatabase(join(dir, 'secretary.db'), store);
  const sessions = new SessionTokens(store);
  const eventBus = new EventBus();
  const app = buildServer({ db, sessions, eventBus, origin: 'https://localhost:47824' });
  await app.ready();

  const bootstrap = sessions.currentBootstrapToken();
  (app as unknown as { __bootstrap: string }).__bootstrap = bootstrap;

  const consume = opts.consumeBootstrap ?? true;
  const session = consume ? sessions.exchangeBootstrap(bootstrap).token : '';
  return { app, store, db, sessions, eventBus, session, bootstrap };
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @secretary/service exec vitest run test/auth-routes.test.ts`
Expected: FAIL — POST `/api/v1/auth/session` returns 404 (route not registered).

- [ ] **Step 4: Create `apps/service/server/api/auth.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '@secretary/shared-types';
import type { SessionTokens } from '../crypto/SessionTokens.js';

const exchangeSchema = z.object({ bootstrapToken: z.string().min(1) });

export function registerAuthRoutes(app: FastifyInstance, deps: { sessions: SessionTokens }): void {
  app.post('/auth/session', async (req) => {
    const parsed = exchangeSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('bootstrapToken is required');
    const { token, expiresAt } = deps.sessions.exchangeBootstrap(parsed.data.bootstrapToken);
    return { data: { token, expiresAt: new Date(expiresAt).toISOString() } };
  });

  app.delete('/auth/session', async () => {
    deps.sessions.revokeAll();
    return { data: { revoked: true } };
  });
}
```

- [ ] **Step 5: Register in `apps/service/server/server.ts`**

Add the import near the other route imports:

```ts
import { registerAuthRoutes } from './api/auth.js';
```

Inside the `app.register(async (api) => { ... }, { prefix: '/api/v1' })` body, replace the `// registerAuthRoutes(...)` comment with:

```ts
registerAuthRoutes(api, deps);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @secretary/service exec vitest run test/auth-routes.test.ts`
Expected: PASS (2 tests — bad token 401 via thrown `AuthError`, valid token 200).

- [ ] **Step 7: Commit**

```bash
git add apps/service/server/api/auth.ts apps/service/server/server.ts apps/service/test/auth-routes.test.ts apps/service/test/helpers/testServer.ts
git commit -m "feat(service): add auth/session bootstrap-exchange and revoke routes"
```

---

## Task 14: Settings routes

**Files:**

- Create: `apps/service/server/api/settings.ts`
- Modify: `apps/service/server/server.ts`
- Test: `apps/service/test/settings-routes.test.ts`

- [ ] **Step 1: Write the failing test** — `apps/service/test/settings-routes.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { makeTestServer } from './helpers/testServer.js';

describe('settings routes', () => {
  it('GET returns seeded settings for an authenticated request', async () => {
    const { app, session } = await makeTestServer();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/settings',
      headers: { authorization: `Bearer ${session}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data['llm.model']).toBe('qwen2.5:14b-instruct-q5_K_M');
    await app.close();
  });

  it('PATCH updates a key and returns the merged view', async () => {
    const { app, session } = await makeTestServer();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: { authorization: `Bearer ${session}` },
      payload: { 'agent.poll_interval_seconds': 30 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data['agent.poll_interval_seconds']).toBe(30);
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @secretary/service exec vitest run test/settings-routes.test.ts`
Expected: FAIL — `/api/v1/settings` returns 404.

- [ ] **Step 3: Create `apps/service/server/api/settings.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3-multiple-ciphers';
import { ValidationError } from '@secretary/shared-types';
import { SettingsRepository } from '../db/repositories/SettingsRepository.js';

export function registerSettingsRoutes(app: FastifyInstance, deps: { db: Database }): void {
  const repo = new SettingsRepository(deps.db);

  app.get('/settings', async () => ({ data: repo.getAll() }));

  app.patch('/settings', async (req) => {
    if (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body)) {
      throw new ValidationError('Body must be an object of settings keys');
    }
    return { data: repo.patch(req.body as Record<string, unknown>) };
  });
}
```

- [ ] **Step 4: Register in `apps/service/server/server.ts`**

Add import:

```ts
import { registerSettingsRoutes } from './api/settings.js';
```

In the prefixed register body, add:

```ts
registerSettingsRoutes(api, deps);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @secretary/service exec vitest run test/settings-routes.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/service/server/api/settings.ts apps/service/server/server.ts apps/service/test/settings-routes.test.ts
git commit -m "feat(service): add settings GET/PATCH routes"
```

---

## Task 15: Push routes

**Files:**

- Create: `apps/service/server/api/push.ts`
- Modify: `apps/service/server/server.ts`
- Test: `apps/service/test/push-routes.test.ts`

- [ ] **Step 1: Write the failing test** — `apps/service/test/push-routes.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { makeTestServer } from './helpers/testServer.js';

const SUB = { endpoint: 'https://push.example/x', keys: { p256dh: 'p', auth: 'a' } };

describe('push routes', () => {
  it('subscribes and the subscription is retrievable via the repository', async () => {
    const { app, session } = await makeTestServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/push/subscribe',
      headers: { authorization: `Bearer ${session}` },
      payload: SUB,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.subscribed).toBe(true);
    await app.close();
  });

  it('push/test reports not configured until VAPID exists (Phase 5.5)', async () => {
    const { app, session } = await makeTestServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/push/test',
      headers: { authorization: `Bearer ${session}` },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('push_not_configured');
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @secretary/service exec vitest run test/push-routes.test.ts`
Expected: FAIL — `/api/v1/push/subscribe` returns 404.

- [ ] **Step 3: Create `apps/service/server/api/push.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3-multiple-ciphers';
import { z } from 'zod';
import { SecretaryError, ValidationError } from '@secretary/shared-types';
import { PushSubscriptionRepository } from '../db/repositories/PushSubscriptionRepository.js';

const subscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
  userAgent: z.string().optional(),
});

class PushNotConfiguredError extends SecretaryError {
  constructor() {
    super('push_not_configured', 'Web Push is not configured yet', 409);
  }
}

export function registerPushRoutes(app: FastifyInstance, deps: { db: Database }): void {
  const repo = new PushSubscriptionRepository(deps.db);

  app.post('/push/subscribe', async (req) => {
    const parsed = subscribeSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid push subscription');
    const { endpoint, keys, userAgent } = parsed.data;
    repo.upsert(userAgent === undefined ? { endpoint, keys } : { endpoint, keys, userAgent });
    return { data: { subscribed: true } };
  });

  app.delete('/push/subscribe/:endpoint', async (req) => {
    const { endpoint } = req.params as { endpoint: string };
    repo.deleteByEndpoint(decodeURIComponent(endpoint));
    return { data: { deleted: true } };
  });

  // VAPID + actual sending arrive in Phase 5.5; until then this is a clear no-op error.
  app.post('/push/test', async () => {
    throw new PushNotConfiguredError();
  });
}
```

- [ ] **Step 4: Register in `apps/service/server/server.ts`**

Add import:

```ts
import { registerPushRoutes } from './api/push.js';
```

In the prefixed register body, add:

```ts
registerPushRoutes(api, deps);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @secretary/service exec vitest run test/push-routes.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/service/server/api/push.ts apps/service/server/server.ts apps/service/test/push-routes.test.ts
git commit -m "feat(service): add push subscribe/unsubscribe routes and stubbed push/test"
```

---

## Task 16: SSE events route

**Files:**

- Create: `apps/service/server/api/events.ts`
- Modify: `apps/service/server/server.ts`
- Test: `apps/service/test/events-route.test.ts`

- [ ] **Step 1: Write the failing test** — `apps/service/test/events-route.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { makeTestServer } from './helpers/testServer.js';

describe('SSE events route', () => {
  it('streams an emitted event as an SSE data frame', async () => {
    const { app, session, eventBus } = await makeTestServer();
    // Emit shortly after the request begins consuming the stream.
    setTimeout(() => eventBus.emit({ type: 'thread:updated', payload: { id: 't1' } }), 20);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/events',
      headers: { authorization: `Bearer ${session}`, accept: 'text/event-stream' },
      payloadAsStream: false,
    });

    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('event: thread:updated');
    expect(res.body).toContain('"id":"t1"');
    await app.close();
  });
});
```

> The SSE handler must close the response after a short idle window so `inject` resolves; in production the connection stays open. Implement with a max-lifetime that is long in prod but short under test via the `SSE_TEST_CLOSE_MS` env override.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @secretary/service exec vitest run test/events-route.test.ts`
Expected: FAIL — `/api/v1/events` returns 404.

- [ ] **Step 3: Create `apps/service/server/api/events.ts`**

```ts
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { EventBus, ServerEvent } from '../eventBus.js';

const HEARTBEAT_MS = 15_000;
// Under test we close the stream quickly so app.inject() resolves; 0 means "never" (prod).
const TEST_CLOSE_MS = Number(process.env.SSE_TEST_CLOSE_MS ?? '0');

function write(reply: FastifyReply, event: ServerEvent): void {
  reply.raw.write(`event: ${event.type}\n`);
  reply.raw.write(`data: ${JSON.stringify(event.payload)}\n\n`);
}

export function registerEventRoutes(app: FastifyInstance, deps: { eventBus: EventBus }): void {
  app.get('/events', (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    reply.raw.write(': connected\n\n');

    const unsubscribe = deps.eventBus.subscribe((event) => write(reply, event));
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), HEARTBEAT_MS);

    const close = (): void => {
      clearInterval(heartbeat);
      clearTimeout(autoClose);
      unsubscribe();
      reply.raw.end();
    };
    const autoClose = TEST_CLOSE_MS > 0 ? setTimeout(close, TEST_CLOSE_MS) : undefined;
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      if (autoClose) clearTimeout(autoClose);
      unsubscribe();
    });
  });
}
```

- [ ] **Step 4: Register in `apps/service/server/server.ts`**

Add import:

```ts
import { registerEventRoutes } from './api/events.js';
```

In the prefixed register body, add:

```ts
registerEventRoutes(api, deps);
```

- [ ] **Step 5: Run test to verify it passes (with the short close window)**

Run: `SSE_TEST_CLOSE_MS=80 pnpm --filter @secretary/service exec vitest run test/events-route.test.ts`
(PowerShell: `$env:SSE_TEST_CLOSE_MS=80; pnpm --filter @secretary/service exec vitest run test/events-route.test.ts; Remove-Item Env:SSE_TEST_CLOSE_MS`)
Expected: PASS (1 test — emitted event appears in the stream body).

- [ ] **Step 6: Commit**

```bash
git add apps/service/server/api/events.ts apps/service/server/server.ts apps/service/test/events-route.test.ts
git commit -m "feat(service): add SSE events route with heartbeat fed by the event bus"
```

---

## Task 17: First-run setup detection

**Files:**

- Create: `apps/service/server/setup/firstRun.ts`
- Test: `apps/service/test/first-run.test.ts`

- [ ] **Step 1: Write the failing test** — `apps/service/test/first-run.test.ts`

```ts
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemorySecretStore } from '../server/auth/SecretStore.js';
import { evaluateFirstRun, NEEDS_SETUP_FILE } from '../server/setup/firstRun.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secretary-setup-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('evaluateFirstRun', () => {
  it('needs setup and writes the flag when required secrets are missing', () => {
    const status = evaluateFirstRun(new InMemorySecretStore(), dir, false);
    expect(status.needsSetup).toBe(true);
    expect(existsSync(join(dir, NEEDS_SETUP_FILE))).toBe(true);
  });

  it('does not need setup once required secrets exist (local-direct: api key + payload key)', () => {
    const store = new InMemorySecretStore();
    store.set('app.gateway-api-key', 'x');
    store.set('app.payload-key', 'y');
    const status = evaluateFirstRun(store, dir, false);
    expect(status.needsSetup).toBe(false);
    expect(existsSync(join(dir, NEEDS_SETUP_FILE))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @secretary/service exec vitest run test/first-run.test.ts`
Expected: FAIL — cannot find module `firstRun.js`.

- [ ] **Step 3: Create `apps/service/server/setup/firstRun.ts`**

```ts
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SecretStore } from '../auth/SecretStore.js';

export const NEEDS_SETUP_FILE = 'needs-setup.flag';

export interface FirstRunStatus {
  needsSetup: boolean;
  missing: string[];
}

/**
 * Determines whether onboarding is required. In local-direct dev (useCfHeaders=false)
 * only the gateway API key + payload key are required; the Cloudflare token is added
 * to the requirements when CF headers are enabled. Writes/removes the needs-setup flag.
 */
export function evaluateFirstRun(
  store: SecretStore,
  dataDir: string,
  useCfHeaders: boolean,
): FirstRunStatus {
  const required = ['app.gateway-api-key', 'app.payload-key'];
  if (useCfHeaders) required.push('app.cf-access-id', 'app.cf-access-secret');

  const missing = required.filter((k) => !store.has(k));
  const needsSetup = missing.length > 0;

  const flagPath = join(dataDir, NEEDS_SETUP_FILE);
  if (needsSetup) {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(flagPath, JSON.stringify({ missing }), 'utf8');
  } else {
    rmSync(flagPath, { force: true });
  }
  return { needsSetup, missing };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @secretary/service exec vitest run test/first-run.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/service/server/setup/firstRun.ts apps/service/test/first-run.test.ts
git commit -m "feat(service): add first-run setup detection with needs-setup flag"
```

---

## Task 18: httpsOptions, placeholder PWA page, headless entrypoint

**Files:**

- Create: `apps/service/server/httpsOptions.ts`
- Create: `apps/service/pwa/index.html`
- Create: `apps/service/server/index.ts`
- Test: `apps/service/test/https-options.test.ts`

- [ ] **Step 1: Write the failing test** — `apps/service/test/https-options.test.ts`

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadHttpsOptions } from '../server/httpsOptions.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secretary-cert-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadHttpsOptions', () => {
  it('throws a helpful error when certs are missing', () => {
    expect(() => loadHttpsOptions(join(dir, 'x.pem'), join(dir, 'x-key.pem'))).toThrow(/mkcert/);
  });

  it('loads cert and key buffers when present', () => {
    const cert = join(dir, 'c.pem');
    const key = join(dir, 'c-key.pem');
    writeFileSync(cert, 'CERT');
    writeFileSync(key, 'KEY');
    const opts = loadHttpsOptions(cert, key);
    expect(opts.cert.toString()).toBe('CERT');
    expect(opts.key.toString()).toBe('KEY');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @secretary/service exec vitest run test/https-options.test.ts`
Expected: FAIL — cannot find module `httpsOptions.js`.

- [ ] **Step 3: Create `apps/service/server/httpsOptions.ts`**

```ts
import { existsSync, readFileSync } from 'node:fs';

export interface HttpsOptions {
  cert: Buffer;
  key: Buffer;
}

/** Loads the mkcert-generated cert/key, with a clear remediation message if absent. */
export function loadHttpsOptions(certPath: string, keyPath: string): HttpsOptions {
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    throw new Error(
      `HTTPS cert not found at ${certPath} / ${keyPath}. ` +
        `Run infra/mkcert/setup-certs.ps1 to generate local certificates (requires mkcert).`,
    );
  }
  return { cert: readFileSync(certPath), key: readFileSync(keyPath) };
}
```

- [ ] **Step 4: Create `apps/service/pwa/index.html`** (placeholder until Phase 2.5)

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Secretary</title>
  </head>
  <body>
    <main style="font-family: system-ui; max-width: 32rem; margin: 4rem auto; padding: 0 1rem;">
      <h1>Secretary</h1>
      <p id="status">Service is running. The app UI arrives in Phase 2.5.</p>
    </main>
    <script>
      // Phase 2.5 replaces this. For now, capture any bootstrap token from the URL fragment.
      const m = location.hash.match(/bootstrap=([^&]+)/);
      if (m) {
        document.getElementById('status').textContent =
          'Bootstrap token received. The setup wizard (Phase 2.5) will exchange it for a session.';
        history.replaceState(null, '', location.pathname);
      }
    </script>
  </body>
</html>
```

- [ ] **Step 5: Create `apps/service/server/index.ts`** (headless entrypoint; serves the static placeholder + listens over HTTPS)

```ts
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
    pwaDir: join(here, '..', '..', 'pwa'),
  });

  await app.listen({ port: config.port, host: config.host });
  log.info({ port: config.port }, 'service listening');

  // Signal readiness to a parent (Electron) process if forked.
  if (process.send) process.send({ type: 'ready', port: config.port });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 6: Extend `buildServer` to accept optional `https` + `pwaDir` and serve the placeholder**

In `apps/service/server/server.ts`, update `ServerDeps`:

```ts
import type { HttpsOptions } from './httpsOptions.js';

export interface ServerDeps {
  db: Database;
  sessions: SessionTokens;
  eventBus: EventBus;
  origin: string;
  https?: HttpsOptions;
  /** Directory containing the placeholder/PWA static files. Omitted in tests. */
  pwaDir?: string;
}
```

Change the Fastify construction to use HTTPS when provided, and serve the static page at `/`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = deps.https
    ? Fastify({ logger: false, https: { cert: deps.https.cert, key: deps.https.key } })
    : Fastify({ logger: false });

  // ...existing cors + onRequest guard + error handler...

  if (deps.pwaDir) {
    const html = readFileSync(join(deps.pwaDir, 'index.html'), 'utf8');
    app.get('/', async (_req, reply) => {
      reply.header('content-type', 'text/html').send(html);
    });
  }

  // ...existing app.register(prefix '/api/v1')...
  return app;
}
```

> `PUBLIC_PATHS` already excludes only `/api/v1/...`; the `/` route is not under the guard since the guard returns early for non-matching auth only on `/api/v1` paths — confirm the guard checks `req.url.startsWith('/api/v1')` before requiring auth. Update the guard's first line to: `if (!req.url.startsWith('/api/v1') || PUBLIC_PATHS.has(req.url.split('?')[0] ?? req.url)) return;`

- [ ] **Step 7: Run typecheck + the https-options test + full suite**

Run: `pnpm --filter @secretary/service typecheck`
Run: `pnpm --filter @secretary/service test`
Expected: typecheck clean; all tests pass (the new https-options test + all prior).

- [ ] **Step 8: Commit**

```bash
git add apps/service/server/httpsOptions.ts apps/service/pwa/index.html apps/service/server/index.ts apps/service/server/server.ts apps/service/test/https-options.test.ts
git commit -m "feat(service): add HTTPS entrypoint, static placeholder page, first-run wiring"
```

---

## Task 19: mkcert dev cert script + manual headless run

**Files:**

- Create: `infra/mkcert/setup-certs.ps1`
- Modify: `infra/mkcert/README.md`

- [ ] **Step 1: Create `infra/mkcert/setup-certs.ps1`**

```powershell
# Generates locally-trusted HTTPS certs for the principal service (Windows dev).
# Requires mkcert: https://github.com/FiloSottile/mkcert  (install via: choco install mkcert)
param(
  [string]$OutDir = "$env:USERPROFILE\.secretary\certs"
)

if (-not (Get-Command mkcert -ErrorAction SilentlyContinue)) {
  Write-Error "mkcert not found. Install it (e.g. 'choco install mkcert') and re-run."
  exit 1
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
mkcert -install
mkcert -cert-file "$OutDir\localhost.pem" -key-file "$OutDir\localhost-key.pem" localhost 127.0.0.1 ::1

Write-Host "Certificates written to $OutDir"
Write-Host "  cert: $OutDir\localhost.pem"
Write-Host "  key:  $OutDir\localhost-key.pem"
```

- [ ] **Step 2: Update `infra/mkcert/README.md`** — add a section:

```markdown
## Principal service dev certificates (Windows)

1. Install mkcert: `choco install mkcert` (or download the release binary).
2. From the repo root run: `pwsh infra/mkcert/setup-certs.ps1`
3. This writes `localhost.pem` + `localhost-key.pem` to `%USERPROFILE%\.secretary\certs`,
   which is where `apps/service` looks by default (`SERVICE_CERT_PATH` / `SERVICE_KEY_PATH`
   override the location).
```

- [ ] **Step 3: Generate certs and run the server headless (manual verification)**

Run: `pwsh infra/mkcert/setup-certs.ps1`
Run: `pnpm --filter @secretary/service dev:server`
In a browser open `https://localhost:47824/` → expect the placeholder page.
With curl: `curl.exe -k https://localhost:47824/api/v1/health` → expect `{"data":{"ok":true}}`.
Stop the server (Ctrl+C).

- [ ] **Step 4: Manual end-to-end gateway round-trip (Phase 2 acceptance)**

Prereqs: Ollama + the Phase 1 gateway running locally. Put the gateway's API key + payload key into the keychain:

```powershell
pnpm --filter @secretary/service set-secret app.gateway-api-key  <the gateway GATEWAY_API_KEY>
pnpm --filter @secretary/service set-secret app.payload-key      <the gateway PAYLOAD_ENCRYPTION_KEY>
```

Then add a temporary manual script `apps/service/test/manual/gateway-round-trip.ts` (mirrors the gateway's own manual test):

```ts
import { KeychainStore } from '../../server/auth/KeychainStore.js';
import { createGatewayClient } from '../../server/llm/GatewayClient.js';

const store = new KeychainStore();
const client = createGatewayClient({
  gatewayUrl: 'http://localhost:47823',
  useCfHeaders: false,
  apiKey: store.get('app.gateway-api-key') ?? '',
  payloadKey: store.get('app.payload-key') ?? '',
});
const out = await client.complete({
  model: 'qwen2.5:14b-instruct-q5_K_M',
  prompt: 'Say hi in 3 words.',
});
console.log(out);
```

Run: `pnpm --filter @secretary/service exec tsx test/manual/gateway-round-trip.ts`
Expected: a decrypted completion prints. This satisfies "calling the gateway via GatewayClient works end-to-end."

- [ ] **Step 5: Commit**

```bash
git add infra/mkcert/setup-certs.ps1 infra/mkcert/README.md apps/service/test/manual/gateway-round-trip.ts
git commit -m "chore(service): add mkcert dev cert script and manual gateway round-trip"
```

---

## Task 20: Electron tray shell (supervises the server child)

**Files:**

- Create: `apps/service/electron/server-process.ts`
- Create: `apps/service/electron/tray-menu.ts`
- Create: `apps/service/electron/main.ts`
- Create: `apps/service/electron/tray-icon.png` (16×16 or 32×32 monochrome placeholder)

> The Electron shell is verified manually (UI), per BRIEF §16. No unit test.

- [ ] **Step 1: Create `apps/service/electron/server-process.ts`**

```ts
import { fork, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export interface ServerHandle {
  child: ChildProcess;
  port: number;
}

/** Forks the headless server (built JS), resolving once it signals readiness. */
export function startServer(): Promise<ServerHandle> {
  const entry = join(here, '..', 'server', 'index.js');
  const child = fork(entry, [], {
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });

  return new Promise<ServerHandle>((resolve, reject) => {
    const onMessage = (msg: unknown): void => {
      if (typeof msg === 'object' && msg && (msg as { type?: string }).type === 'ready') {
        child.off('message', onMessage);
        resolve({ child, port: (msg as { port: number }).port });
      }
    };
    child.on('message', onMessage);
    child.on('exit', (code) => reject(new Error(`Server exited early (code ${code ?? 'null'})`)));
  });
}
```

- [ ] **Step 2: Create `apps/service/electron/tray-menu.ts`**

```ts
import { Menu, shell, type MenuItemConstructorOptions } from 'electron';

export interface TrayMenuActions {
  port: number;
  needsSetup: boolean;
  bootstrapToken: string;
  onPauseResume: () => void;
  paused: boolean;
  onQuit: () => void;
  logPath: string;
}

export function buildTrayMenu(a: TrayMenuActions): Menu {
  const openUrl = a.needsSetup
    ? `https://localhost:${a.port}/#bootstrap=${a.bootstrapToken}`
    : `https://localhost:${a.port}/#bootstrap=${a.bootstrapToken}`;

  const items: MenuItemConstructorOptions[] = [
    {
      label: a.needsSetup ? 'Setup required — Open Secretary' : 'Open Secretary',
      click: () => void shell.openExternal(openUrl),
    },
    { type: 'separator' },
    { label: a.paused ? 'Resume' : 'Pause', click: a.onPauseResume },
    { label: 'View Logs', click: () => void shell.openPath(a.logPath) },
    { type: 'separator' },
    { label: 'Quit', click: a.onQuit },
  ];
  return Menu.buildFromTemplate(items);
}
```

- [ ] **Step 3: Create `apps/service/electron/main.ts`**

```ts
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, Tray, nativeImage } from 'electron';
import { startServer, type ServerHandle } from './server-process.js';
import { buildTrayMenu } from './tray-menu.js';

const here = dirname(fileURLToPath(import.meta.url));
let tray: Tray | undefined;
let server: ServerHandle | undefined;
let paused = false;

async function bootstrap(): Promise<void> {
  server = await startServer();

  const icon = nativeImage.createFromPath(join(here, 'tray-icon.png'));
  tray = new Tray(icon);
  tray.setToolTip('Secretary');

  const refresh = (): void => {
    tray?.setContextMenu(
      buildTrayMenu({
        port: server?.port ?? 47824,
        needsSetup: false, // read from the server's first-run status via IPC in a later iteration
        bootstrapToken: '',
        paused,
        onPauseResume: () => {
          paused = !paused;
          refresh();
        },
        onQuit: () => app.quit(),
        logPath: join(app.getPath('home'), '.secretary', 'logs', 'service.log'),
      }),
    );
  };
  refresh();
}

app
  .whenReady()
  .then(bootstrap)
  .catch((err) => {
    console.error(err);
    app.quit();
  });

app.on('window-all-closed', () => {
  /* tray-only app: do not quit when no windows */
});

app.on('before-quit', () => {
  server?.child.kill();
});
```

> The bootstrap-token/needs-setup values shown in the tray come from the server. For this task, the menu opens the browser to the served origin; wiring the live bootstrap token + setup status over IPC is a small follow-up (note it in the task's commit body, tracked for Phase 2.5 where the wizard consumes it).

- [ ] **Step 4: Add a placeholder tray icon**

Create `apps/service/electron/tray-icon.png` — any small (32×32) PNG works for v1. Generate a solid square if none is handy:

Run (PowerShell):

```powershell
$bytes = [Convert]::FromBase64String("iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAHElEQVRYhe3BAQ0AAADCoPdPbQ43oAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAvwYwAAFm2Z3qAAAAAElFTkSuQmCC")
[IO.File]::WriteAllBytes("apps/service/electron/tray-icon.png", $bytes)
```

- [ ] **Step 5: Build, rebuild native module for Electron, run the tray**

Run: `pnpm --filter @secretary/service build`
Run: `pnpm --filter @secretary/service rebuild:electron`
(If this step fails for lack of a compiler, install "Visual Studio Build Tools" with the C++ workload, then retry. The `dev:server` path remains available regardless.)
Run: `pnpm --filter @secretary/service dev`
Expected: a tray icon appears; "Open Secretary" opens the browser to the placeholder page over HTTPS; "Quit" exits and the server child is terminated.

- [ ] **Step 6: Commit**

```bash
git add apps/service/electron
git commit -m "feat(service): add Electron tray shell that supervises the server child"
```

---

## Task 21: Full verification + workspace sweep

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the whole workspace**

Run: `pnpm -r typecheck`
Expected: all packages clean.

- [ ] **Step 2: Run the whole test suite**

Run: `pnpm -r test`
Expected: gateway 39 + crypto 19 + llm-protocol 14 (unchanged) and the new `@secretary/service` suite all pass.

- [ ] **Step 3: Lint + format check**

Run: `pnpm lint`
Run: `pnpm format:check`
Expected: clean (fix with `pnpm format` if needed, then re-commit).

- [ ] **Step 4: Confirm Phase 2 acceptance criteria (BRIEF §14) and update the brief if anything diverged**

Walk the acceptance table from the spec; verify each. If any implementation detail diverged from `BRIEF.md`, update the brief in this commit per its §18 working agreement.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore(service): phase 2 verification sweep (typecheck, tests, lint)"
```

---

## Self-Review (completed during planning)

**Spec coverage:** Every spec section maps to a task — tray shell (T20), Fastify HTTPS (T18/T19), SQLCipher + migrations + seed (T5–T7), repositories just-in-time (T8/T9), GatewayClient local-direct (T10), first-run detection (T17), bootstrap→session (T11/T13), settings (T14), push subscribe/test-stub (T15), SSE (T16), logging (T4), KeychainStore + cross-platform seam (T2), mkcert (T19). Acceptance criteria verified in T19 (manual run + gateway round-trip) and T21.

**Placeholder scan:** No "TBD"/"implement later" in code steps; every code step contains complete content. The Electron tray's live bootstrap-token/needs-setup IPC is intentionally deferred with an explicit note (the menu still functions; the wizard that consumes the token is Phase 2.5) — flagged, not hidden.

**Type consistency:** `SecretStore` methods (`get/set/delete/has`) are used identically across `connection.ts`, `SessionTokens`, `firstRun.ts`. `createGatewayClient(GatewayClientOptions)` matches its test call sites. `buildServer(ServerDeps)` is extended additively in T18 (optional `https`/`pwaDir`) and `makeTestServer` is updated in the same task that changes its shape (T13). `runMigrations(db, Migration[])` signature is stable across T5/T6/T7. `EventBus.subscribe/emit` match between `eventBus.ts` and `events.ts`.
