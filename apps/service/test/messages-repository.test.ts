import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RawMessage } from '@secretary/shared-types';
import { InMemorySecretStore } from '../server/auth/SecretStore.js';
import { openDatabase } from '../server/db/connection.js';
import { MessagesRepository } from '../server/db/repositories/MessagesRepository.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secretary-messages-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seed(db: ReturnType<typeof openDatabase>) {
  db.prepare(
    `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','a@b.com')`,
  ).run();
  db.prepare(
    `INSERT INTO threads (id, account_id, state) VALUES ('th1','acc1','needs_classification')`,
  ).run();
}

const raw: RawMessage = {
  providerId: 'uid-1',
  messageIdHeader: '<m1@x>',
  references: [],
  from: { address: 'a@b.com', name: 'A' },
  to: [{ address: 'c@d.com' }],
  cc: [],
  bcc: [],
  subject: 'Hi',
  bodyText: 'hello',
  snippet: 'hello',
  direction: 'inbound',
  dateReceived: 1000,
  isRead: false,
  isStarred: false,
  folder: 'INBOX',
  labels: [],
  attachmentsMeta: [],
};

describe('MessagesRepository', () => {
  it('inserts a message and is idempotent on (account_id, provider_id)', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    seed(db);
    const repo = new MessagesRepository(db);
    const first = repo.insert('acc1', 'th1', raw);
    const second = repo.insert('acc1', 'th1', raw); // duplicate provider_id
    const list = repo.listByThread('th1');
    db.close();
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(list).toHaveLength(1);
    expect(list[0]?.message_id_header).toBe('<m1@x>');
  });
});
