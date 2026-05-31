import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemorySecretStore } from '../server/auth/SecretStore.js';
import { openDatabase } from '../server/db/connection.js';
import { SettingsRepository } from '../server/db/repositories/SettingsRepository.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secretary-settings-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function repo() {
  const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
  return new SettingsRepository(db);
}

describe('SettingsRepository', () => {
  it('reads a seeded default as its parsed JSON value', () => {
    const r = repo();
    const result = r.get('agent.poll_interval_seconds');
    (r as unknown as { db: { close(): void } }).db.close();
    expect(result).toBe(60);
  });

  it('getAll returns an object keyed by setting name', () => {
    const r = repo();
    const all = r.getAll();
    (r as unknown as { db: { close(): void } }).db.close();
    expect(all['llm.model']).toBe('qwen2.5:14b-instruct-q5_K_M');
  });

  it('patch upserts multiple keys and returns the merged view', () => {
    const r = repo();
    const merged = r.patch({ 'agent.poll_interval_seconds': 30, 'llm.temperature.draft': 0.7 });
    const draft = r.get('llm.temperature.draft');
    (r as unknown as { db: { close(): void } }).db.close();
    expect(merged['agent.poll_interval_seconds']).toBe(30);
    expect(draft).toBe(0.7);
  });
});
