import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3-multiple-ciphers';
import type { FollowUpRow } from '../schema.js';

export interface FollowUpInsert {
  threadId: string;
  triggerAt: number;
  reason: FollowUpRow['reason'];
  description?: string;
  status?: FollowUpRow['status'];
  createdAt: number;
}

export class FollowUpsRepository {
  constructor(private readonly db: Database.Database) {}

  insert(input: FollowUpInsert): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO follow_ups (id, thread_id, trigger_at, reason, description, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.threadId,
        input.triggerAt,
        input.reason,
        input.description ?? null,
        input.status ?? 'pending',
        input.createdAt,
      );
    return id;
  }

  hasPending(threadId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS x FROM follow_ups WHERE thread_id = ? AND status = 'pending' LIMIT 1")
      .get(threadId) as { x: number } | undefined;
    return row !== undefined;
  }

  listPending(): FollowUpRow[] {
    return this.db
      .prepare("SELECT * FROM follow_ups WHERE status = 'pending' ORDER BY trigger_at ASC")
      .all() as FollowUpRow[];
  }

  dismiss(id: string): void {
    this.db.prepare("UPDATE follow_ups SET status = 'dismissed' WHERE id = ?").run(id);
  }

  resolve(id: string, now: number = Date.now()): void {
    this.db
      .prepare("UPDATE follow_ups SET status = 'resolved', resolved_at = ? WHERE id = ?")
      .run(now, id);
  }
}
