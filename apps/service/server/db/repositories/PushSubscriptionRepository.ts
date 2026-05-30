import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3-multiple-ciphers';
import type { PushSubscriptionRow } from '../schema.js';

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
}

export class PushSubscriptionRepository {
  constructor(private readonly db: Database.Database) {}

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
