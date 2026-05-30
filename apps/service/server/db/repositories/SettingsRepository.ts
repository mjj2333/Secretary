import type Database from 'better-sqlite3-multiple-ciphers';
import type { SettingRow } from '../schema.js';

export class SettingsRepository {
  constructor(private readonly db: Database.Database) {}

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
