import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3-multiple-ciphers';
import type { ThreadState, Urgency } from '@secretary/shared-types';
import type { ThreadRow } from '../schema.js';

export interface ClassificationUpdate {
  state: ThreadState;
  urgency: Urgency;
  summary: string;
  slaDeadline: number | null;
  stateChangedAt: number;
  stateReason: string;
}

export interface StateUpdate {
  state: ThreadState;
  slaDeadline: number | null;
  stateChangedAt: number;
  stateReason: string;
}

/** A thread row plus whether it has a pending follow-up (for the needs-attention view). */
export type AttentionRow = ThreadRow & { has_pending: number };

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

  applyClassification(id: string, u: ClassificationUpdate): void {
    this.db
      .prepare(
        `UPDATE threads SET
           state = ?, urgency = ?, last_agent_summary = ?, sla_deadline = ?,
           state_changed_at = ?, state_reason = ?
         WHERE id = ?`,
      )
      .run(u.state, u.urgency, u.summary, u.slaDeadline, u.stateChangedAt, u.stateReason, id);
  }

  setState(id: string, u: StateUpdate): void {
    this.db
      .prepare(
        `UPDATE threads SET state = ?, sla_deadline = ?, state_changed_at = ?, state_reason = ?
         WHERE id = ?`,
      )
      .run(u.state, u.slaDeadline, u.stateChangedAt, u.stateReason, id);
  }

  findNeedsClassification(): ThreadRow[] {
    return this.db
      .prepare("SELECT * FROM threads WHERE state = 'needs_classification'")
      .all() as ThreadRow[];
  }

  /** Overdue threads in an active state with no pending follow-up (BRIEF §11 follow-up engine). */
  findSlaBreaches(now: number): ThreadRow[] {
    return this.db
      .prepare(
        `SELECT * FROM threads t
         WHERE t.sla_deadline IS NOT NULL
           AND t.sla_deadline < ?
           AND t.state IN ('awaiting_your_reply','awaiting_their_reply')
           AND NOT EXISTS (
             SELECT 1 FROM follow_ups f WHERE f.thread_id = t.id AND f.status = 'pending'
           )`,
      )
      .all(now) as ThreadRow[];
  }

  /** awaiting_your_reply OR has a pending follow-up; urgency DESC then sla_deadline ASC (nulls last). */
  needsAttention(): AttentionRow[] {
    return this.db
      .prepare(
        `SELECT t.*,
                EXISTS (SELECT 1 FROM follow_ups f WHERE f.thread_id = t.id AND f.status = 'pending') AS has_pending
         FROM threads t
         WHERE t.state = 'awaiting_your_reply'
            OR EXISTS (SELECT 1 FROM follow_ups f WHERE f.thread_id = t.id AND f.status = 'pending')
         ORDER BY
           CASE t.urgency WHEN 'high' THEN 0 WHEN 'normal' THEN 1 WHEN 'low' THEN 2 ELSE 3 END ASC,
           CASE WHEN t.sla_deadline IS NULL THEN 1 ELSE 0 END ASC,
           t.sla_deadline ASC`,
      )
      .all() as AttentionRow[];
  }
}
