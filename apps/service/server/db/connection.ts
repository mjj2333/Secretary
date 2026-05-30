import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3-multiple-ciphers';
import type { SecretStore } from '../auth/SecretStore.js';
import { runMigrations } from './migrate.js';
import { migrations } from './migrations/index.js';
import { seedSettings } from './seed.js';

export const DB_KEY_SECRET = 'app.db-key';

type DB = Database.Database;

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
