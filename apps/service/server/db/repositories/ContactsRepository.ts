import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3-multiple-ciphers';
import type { ContactCategory, EmailAddress, MessageDirection } from '@secretary/shared-types';
import type { ContactRow } from '../schema.js';

export interface ContactPatch {
  category?: ContactCategory;
  notes?: string;
  styleNotes?: unknown;
  doNotAutoDraft?: boolean;
}

export class ContactsRepository {
  constructor(private readonly db: Database.Database) {}

  findByEmail(email: string): ContactRow | undefined {
    return this.db
      .prepare('SELECT * FROM contacts WHERE email_address = ? COLLATE NOCASE')
      .get(email) as ContactRow | undefined;
  }

  /** Inserts the contact if new, then bumps the in/out counter and last_contact_at. */
  recordSeen(addr: EmailAddress, direction: MessageDirection, whenMs: number): void {
    const existing = this.findByEmail(addr.address);
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO contacts (id, email_address, display_name, category, first_contact_at, last_contact_at, total_messages_in, total_messages_out, do_not_auto_draft)
           VALUES (?, ?, ?, 'unknown', ?, ?, 0, 0, 0)`,
        )
        .run(randomUUID(), addr.address, addr.name ?? null, whenMs, whenMs);
    }
    const col = direction === 'inbound' ? 'total_messages_in' : 'total_messages_out';
    this.db
      .prepare(
        `UPDATE contacts SET ${col} = ${col} + 1,
           last_contact_at = MAX(COALESCE(last_contact_at, 0), ?)
         WHERE email_address = ? COLLATE NOCASE`,
      )
      .run(whenMs, addr.address);
  }

  getById(id: string): ContactRow | undefined {
    return this.db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as ContactRow | undefined;
  }

  list(opts: { category?: ContactCategory; limit: number; offset: number }): ContactRow[] {
    if (opts.category) {
      return this.db
        .prepare(
          `SELECT * FROM contacts WHERE category = ?
           ORDER BY COALESCE(last_contact_at, 0) DESC LIMIT ? OFFSET ?`,
        )
        .all(opts.category, opts.limit, opts.offset) as ContactRow[];
    }
    return this.db
      .prepare(`SELECT * FROM contacts ORDER BY COALESCE(last_contact_at, 0) DESC LIMIT ? OFFSET ?`)
      .all(opts.limit, opts.offset) as ContactRow[];
  }

  /** Updates only the provided fields; returns the updated row. */
  patch(id: string, fields: ContactPatch): ContactRow | undefined {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (fields.category !== undefined) {
      sets.push('category = ?');
      vals.push(fields.category);
    }
    if (fields.notes !== undefined) {
      sets.push('notes = ?');
      vals.push(fields.notes);
    }
    if (fields.styleNotes !== undefined) {
      sets.push('style_notes = ?');
      vals.push(JSON.stringify(fields.styleNotes));
    }
    if (fields.doNotAutoDraft !== undefined) {
      sets.push('do_not_auto_draft = ?');
      vals.push(fields.doNotAutoDraft ? 1 : 0);
    }
    if (sets.length > 0) {
      this.db.prepare(`UPDATE contacts SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    }
    return this.getById(id);
  }
}
