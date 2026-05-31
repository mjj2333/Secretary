import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemorySecretStore } from '../server/auth/SecretStore.js';
import { openDatabase } from '../server/db/connection.js';
import { PushSubscriptionRepository } from '../server/db/repositories/PushSubscriptionRepository.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secretary-push-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const SUB = {
  endpoint: 'https://push.example/abc',
  keys: { p256dh: 'p256dh-value', auth: 'auth-value' },
  userAgent: 'test-agent',
};

describe('PushSubscriptionRepository', () => {
  it('upserts by endpoint (no duplicates) and lists subscriptions', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    const r = new PushSubscriptionRepository(db);
    r.upsert(SUB);
    r.upsert(SUB);
    const list = r.list();
    db.close();
    expect(list).toHaveLength(1);
    expect(list[0]?.endpoint).toBe(SUB.endpoint);
  });

  it('deletes by endpoint', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    const r = new PushSubscriptionRepository(db);
    r.upsert(SUB);
    r.deleteByEndpoint(SUB.endpoint);
    const list = r.list();
    db.close();
    expect(list).toHaveLength(0);
  });
});
