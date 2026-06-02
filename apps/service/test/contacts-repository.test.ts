import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemorySecretStore } from '../server/auth/SecretStore.js';
import { openDatabase } from '../server/db/connection.js';
import { ContactsRepository } from '../server/db/repositories/ContactsRepository.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secretary-contacts-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ContactsRepository', () => {
  it('upserts by email (case-insensitive) and bumps counts', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    const repo = new ContactsRepository(db);
    repo.recordSeen({ address: 'Alice@Example.com', name: 'Alice' }, 'inbound', 1000);
    repo.recordSeen({ address: 'alice@example.com' }, 'inbound', 2000);
    const c = repo.findByEmail('ALICE@example.com');
    db.close();
    expect(c?.total_messages_in).toBe(2);
    expect(c?.last_contact_at).toBe(2000);
  });

  it('getById, list (filtered by category), and patch', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    const repo = new ContactsRepository(db);
    repo.recordSeen({ address: 'alice@example.com', name: 'Alice' }, 'inbound', 1000);
    repo.recordSeen({ address: 'vendor@x.com', name: 'Vendor' }, 'inbound', 1500);
    const alice = repo.findByEmail('alice@example.com')!;

    expect(repo.getById(alice.id)?.email_address).toBe('alice@example.com');
    expect(repo.getById('missing')).toBeUndefined();

    expect(repo.list({ limit: 10, offset: 0 })).toHaveLength(2);

    const updated = repo.patch(alice.id, {
      category: 'client_new',
      notes: 'Met at the expo',
      doNotAutoDraft: true,
      styleNotes: 'Warm and brief.',
    });
    expect(updated?.category).toBe('client_new');
    expect(updated?.notes).toBe('Met at the expo');
    expect(updated?.do_not_auto_draft).toBe(1);
    expect(updated?.style_notes).toBe('Warm and brief.');

    expect(repo.list({ category: 'client_new', limit: 10, offset: 0 }).map((c) => c.id)).toEqual([
      alice.id,
    ]);
    db.close();
  });
});
