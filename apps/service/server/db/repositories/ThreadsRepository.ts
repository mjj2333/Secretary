import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3-multiple-ciphers';
import type { ThreadRow } from '../schema.js';

export interface ThreadTouch {
  lastMessageAt?: number;
  lastInboundAt?: number;
  lastOutboundAt?: number;
}

export class ThreadsRepository {
  constructor(private readonly db: Database.Database) {}

  create(
    accountId: string,
    subjectNormalized: string,
    participants: string[],
    whenMs: number,
  ): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO threads (id, account_id, subject_normalized, participants, message_count, first_message_at, last_message_at, state, state_changed_at)
         VALUES (?, ?, ?, ?, 0, ?, ?, 'needs_classification', ?)`,
      )
      .run(id, accountId, subjectNormalized, JSON.stringify(participants), whenMs, whenMs, whenMs);
    return id;
  }

  threadIdForSubject(accountId: string, subjectNormalized: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT id FROM threads WHERE account_id = ? AND subject_normalized = ?
         ORDER BY last_message_at DESC LIMIT 1`,
      )
      .get(accountId, subjectNormalized) as { id: string } | undefined;
    return row?.id;
  }

  /** Thread id containing any message whose Message-ID header is in the list. */
  threadIdForMessageIds(accountId: string, messageIds: string[]): string | undefined {
    if (messageIds.length === 0) return undefined;
    const placeholders = messageIds.map(() => '?').join(',');
    const row = this.db
      .prepare(
        `SELECT thread_id AS id FROM messages
         WHERE account_id = ? AND message_id_header IN (${placeholders}) LIMIT 1`,
      )
      .get(accountId, ...messageIds) as { id: string } | undefined;
    return row?.id;
  }

  touch(id: string, t: ThreadTouch): void {
    this.db
      .prepare(
        `UPDATE threads SET
           message_count = message_count + 1,
           last_message_at = MAX(COALESCE(last_message_at,0), COALESCE(?, last_message_at, 0)),
           last_inbound_at = MAX(COALESCE(last_inbound_at,0), COALESCE(?, last_inbound_at, 0)),
           last_outbound_at = MAX(COALESCE(last_outbound_at,0), COALESCE(?, last_outbound_at, 0))
         WHERE id = ?`,
      )
      .run(t.lastMessageAt ?? null, t.lastInboundAt ?? null, t.lastOutboundAt ?? null, id);
  }

  get(id: string): ThreadRow | undefined {
    return this.db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as ThreadRow | undefined;
  }

  listByAccount(accountId: string, limit: number, offset: number): ThreadRow[] {
    return this.db
      .prepare(
        `SELECT * FROM threads WHERE account_id = ?
         ORDER BY last_message_at DESC LIMIT ? OFFSET ?`,
      )
      .all(accountId, limit, offset) as ThreadRow[];
  }
}
