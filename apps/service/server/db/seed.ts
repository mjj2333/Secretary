import type Database from 'better-sqlite3-multiple-ciphers';

/** Default settings from BRIEF §6. Stored as JSON strings in the `value` column. */
const DEFAULTS: Record<string, unknown> = {
  'agent.classify_on_inbound': true,
  'agent.autodraft_on_inbound': false,
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
export function seedSettings(db: Database.Database): void {
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
