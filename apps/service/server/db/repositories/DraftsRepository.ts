import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3-multiple-ciphers';
import type { DiffOp, EmailAddress } from '@secretary/shared-types';
import type { DraftRow } from '../schema.js';

export interface DraftInsert {
  threadId: string;
  accountId: string;
  version: number;
  inReplyToMessageId: string | null;
  to: EmailAddress[];
  cc: EmailAddress[];
  subject: string | null;
  bodyText: string;
  generatedBodyText: string;
  rawIntent: string | null;
  polishDiff: DiffOp[] | null;
  systemPromptUsed: string;
  modelUsed: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  createdAt: number;
}

export class DraftsRepository {
  constructor(private readonly db: Database.Database) {}

  /** The next version number for a thread (1-based). */
  nextVersion(threadId: string): number {
    const row = this.db
      .prepare('SELECT MAX(version) AS v FROM drafts WHERE thread_id = ?')
      .get(threadId) as { v: number | null };
    return (row.v ?? 0) + 1;
  }

  insert(input: DraftInsert): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO drafts
          (id, thread_id, account_id, version, in_reply_to_message_id, to_addresses, cc_addresses,
           subject, body_text, generated_body_text, raw_intent, polish_diff, system_prompt_used, model_used,
           tokens_in, tokens_out, latency_ms, status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending_review', ?)`,
      )
      .run(
        id,
        input.threadId,
        input.accountId,
        input.version,
        input.inReplyToMessageId,
        JSON.stringify(input.to),
        JSON.stringify(input.cc),
        input.subject,
        input.bodyText,
        input.generatedBodyText,
        input.rawIntent,
        input.polishDiff ? JSON.stringify(input.polishDiff) : null,
        input.systemPromptUsed,
        input.modelUsed,
        input.tokensIn,
        input.tokensOut,
        input.latencyMs,
        input.createdAt,
      );
    return id;
  }

  getById(id: string): DraftRow | undefined {
    return this.db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as DraftRow | undefined;
  }

  /** Highest-version draft for a thread that hasn't been discarded. */
  latestForThread(threadId: string): DraftRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM drafts WHERE thread_id = ? AND status != 'discarded'
         ORDER BY version DESC LIMIT 1`,
      )
      .get(threadId) as DraftRow | undefined;
  }

  /** Highest-version draft for a thread that is still reviewable (not sent/discarded). */
  currentForThread(threadId: string): DraftRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM drafts WHERE thread_id = ? AND status NOT IN ('sent','discarded')
         ORDER BY version DESC LIMIT 1`,
      )
      .get(threadId) as DraftRow | undefined;
  }

  updateBody(id: string, fields: { bodyText?: string; subject?: string }): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (fields.bodyText !== undefined) {
      sets.push('body_text = ?');
      vals.push(fields.bodyText);
    }
    if (fields.subject !== undefined) {
      sets.push('subject = ?');
      vals.push(fields.subject);
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE drafts SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  }

  markSent(id: string, fields: { sentAt: number; finalBodySent: string }): void {
    this.db
      .prepare("UPDATE drafts SET status = 'sent', sent_at = ?, final_body_sent = ? WHERE id = ?")
      .run(fields.sentAt, fields.finalBodySent, id);
  }

  markDiscarded(id: string): void {
    this.db.prepare("UPDATE drafts SET status = 'discarded' WHERE id = ?").run(id);
  }

  markFailed(id: string): void {
    this.db.prepare("UPDATE drafts SET status = 'failed' WHERE id = ?").run(id);
  }
}
