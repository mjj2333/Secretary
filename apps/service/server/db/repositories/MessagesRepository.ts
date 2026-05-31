import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3-multiple-ciphers';
import type { RawMessage } from '@secretary/shared-types';
import type { MessageRow } from '../schema.js';

export class MessagesRepository {
  constructor(private readonly db: Database.Database) {}

  /** Inserts a message; returns false (no-op) if (account_id, provider_id) already exists. */
  insert(accountId: string, threadId: string, raw: RawMessage): boolean {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages
          (id, account_id, provider_id, thread_id, message_id_header, in_reply_to, references_header,
           from_address, from_name, to_addresses, cc_addresses, bcc_addresses, subject, body_text,
           body_html, snippet, direction, date_sent, date_received, is_read, is_starred, folder,
           labels, attachments_meta, raw_size_bytes, synced_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        randomUUID(),
        accountId,
        raw.providerId,
        threadId,
        raw.messageIdHeader ?? null,
        raw.inReplyTo ?? null,
        JSON.stringify(raw.references),
        raw.from.address,
        raw.from.name ?? null,
        JSON.stringify(raw.to),
        JSON.stringify(raw.cc),
        JSON.stringify(raw.bcc),
        raw.subject ?? null,
        raw.bodyText ?? null,
        raw.bodyHtml ?? null,
        raw.snippet ?? null,
        raw.direction,
        raw.dateSent ?? null,
        raw.dateReceived ?? null,
        raw.isRead ? 1 : 0,
        raw.isStarred ? 1 : 0,
        raw.folder,
        JSON.stringify(raw.labels),
        JSON.stringify(raw.attachmentsMeta),
        raw.rawSizeBytes ?? null,
        Date.now(),
      );
    return info.changes > 0;
  }

  existsByProviderId(accountId: string, providerId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 AS x FROM messages WHERE account_id = ? AND provider_id = ? LIMIT 1')
      .get(accountId, providerId) as { x: number } | undefined;
    return row !== undefined;
  }

  listByThread(threadId: string): MessageRow[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY COALESCE(date_received, 0) ASC')
      .all(threadId) as MessageRow[];
  }
}
