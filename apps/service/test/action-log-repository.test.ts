import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemorySecretStore } from '../server/auth/SecretStore.js';
import { openDatabase } from '../server/db/connection.js';
import { ActionLogRepository } from '../server/db/repositories/ActionLogRepository.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secretary-actionlog-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ActionLogRepository', () => {
  it('appends an entry', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    const repo = new ActionLogRepository(db);
    repo.append({
      actor: 'system',
      action: 'message_synced',
      targetType: 'message',
      targetId: 'm1',
    });
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM action_log').get() as { n: number };
    db.close();
    expect(n).toBe(1);
  });
});
