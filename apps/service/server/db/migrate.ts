import type Database from 'better-sqlite3-multiple-ciphers';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Applies any migrations whose version is greater than the highest applied version.
 * Each migration runs inside a transaction. Returns the versions applied this run.
 */
export function runMigrations(db: Database.Database, migrations: Migration[]): number[] {
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
