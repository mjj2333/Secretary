import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3-multiple-ciphers';
import type { ContactCategory } from '@secretary/shared-types';
import type { StyleExampleRow, StyleExampleStatus } from '../schema.js';

export interface StyleExampleInsert {
  sourceMessageId: string;
  contactCategory: string | null;
  contextSummary: string;
  replyText: string;
  tags: string;
}

export class StyleExamplesRepository {
  constructor(private readonly db: Database.Database) {}

  /** Up to `limit` APPROVED examples for the category; falls back to any approved when none match. */
  sample(category: ContactCategory, limit: number): StyleExampleRow[] {
    const matched = this.db
      .prepare("SELECT * FROM style_examples WHERE contact_category = ? AND status = 'approved' LIMIT ?")
      .all(category, limit) as StyleExampleRow[];
    if (matched.length >= limit) return matched;
    if (matched.length > 0) return matched;
    return this.db
      .prepare("SELECT * FROM style_examples WHERE status = 'approved' LIMIT ?")
      .all(limit) as StyleExampleRow[];
  }

  /** True if a style example already exists for this source message (idempotent mining). */
  existsForMessage(messageId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 AS x FROM style_examples WHERE source_message_id = ? LIMIT 1')
      .get(messageId) as { x: number } | undefined;
    return row !== undefined;
  }

  /** Inserts a mined example in the `pending` state; returns its id. */
  insertPending(input: StyleExampleInsert): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO style_examples
          (id, source_message_id, contact_category, context_summary, reply_text, tags, status)
         VALUES (?,?,?,?,?,?, 'pending')`,
      )
      .run(id, input.sourceMessageId, input.contactCategory, input.contextSummary, input.replyText, input.tags);
    return id;
  }

  listByStatus(status: StyleExampleStatus): StyleExampleRow[] {
    return this.db
      .prepare('SELECT * FROM style_examples WHERE status = ? ORDER BY rowid DESC')
      .all(status) as StyleExampleRow[];
  }

  listAll(): StyleExampleRow[] {
    return this.db.prepare('SELECT * FROM style_examples ORDER BY rowid DESC').all() as StyleExampleRow[];
  }

  getById(id: string): StyleExampleRow | undefined {
    return this.db.prepare('SELECT * FROM style_examples WHERE id = ?').get(id) as
      | StyleExampleRow
      | undefined;
  }

  setStatus(id: string, status: StyleExampleStatus): void {
    this.db.prepare('UPDATE style_examples SET status = ? WHERE id = ?').run(status, id);
  }

  update(id: string, fields: { contextSummary?: string; replyText?: string; tags?: string }): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (fields.contextSummary !== undefined) {
      sets.push('context_summary = ?');
      vals.push(fields.contextSummary);
    }
    if (fields.replyText !== undefined) {
      sets.push('reply_text = ?');
      vals.push(fields.replyText);
    }
    if (fields.tags !== undefined) {
      sets.push('tags = ?');
      vals.push(fields.tags);
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE style_examples SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  }
}
