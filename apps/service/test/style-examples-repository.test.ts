import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemorySecretStore } from '../server/auth/SecretStore.js';
import { openDatabase } from '../server/db/connection.js';
import { StyleExamplesRepository } from '../server/db/repositories/StyleExamplesRepository.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secretary-style-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('StyleExamplesRepository.sample', () => {
  it('returns [] when the table is empty (v1)', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    const repo = new StyleExamplesRepository(db);
    const out = repo.sample('client_new', 3);
    db.close();
    expect(out).toEqual([]);
  });

  it('prefers category matches, then falls back to any', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    db.prepare(
      `INSERT INTO style_examples (id, contact_category, context_summary, reply_text) VALUES ('s1','client_new','ctx','reply-cn')`,
    ).run();
    db.prepare(
      `INSERT INTO style_examples (id, contact_category, context_summary, reply_text) VALUES ('s2','vendor','ctx','reply-v')`,
    ).run();
    const repo = new StyleExamplesRepository(db);
    const matched = repo.sample('client_new', 3).map((r) => r.id);
    const fallback = repo
      .sample('personal', 3)
      .map((r) => r.id)
      .sort();
    db.close();
    expect(matched).toEqual(['s1']); // category match only
    expect(fallback).toEqual(['s1', 's2']); // no 'personal' match -> any
  });
});
