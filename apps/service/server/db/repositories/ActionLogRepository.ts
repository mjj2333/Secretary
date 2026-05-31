import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3-multiple-ciphers';

export interface ActionLogEntry {
  actor: 'agent' | 'user' | 'system';
  action: string;
  targetType?: string;
  targetId?: string;
  /** action-specific metadata — NEVER message bodies/prompts. */
  details?: Record<string, unknown>;
}

export class ActionLogRepository {
  constructor(private readonly db: Database.Database) {}

  append(entry: ActionLogEntry): void {
    this.db
      .prepare(
        `INSERT INTO action_log (id, timestamp, actor, action, target_type, target_id, details)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        Date.now(),
        entry.actor,
        entry.action,
        entry.targetType ?? null,
        entry.targetId ?? null,
        entry.details ? JSON.stringify(entry.details) : null,
      );
  }
}
