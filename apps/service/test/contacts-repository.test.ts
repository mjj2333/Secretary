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
});
