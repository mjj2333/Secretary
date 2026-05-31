import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3-multiple-ciphers';
import type { EmailAddress, MessageDirection } from '@secretary/shared-types';
import type { ContactRow } from '../schema.js';

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
}
