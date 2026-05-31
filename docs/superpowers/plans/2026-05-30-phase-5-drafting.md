# Phase 5 — Drafting + Review + Send Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An LLM `Drafter` writes reply emails for threads that need one, exposed through a versioned `drafts` review/edit/send API, with an (off-by-default) auto-draft hook from the Phase 4 Classifier.

**Architecture:** A `Drafter` parallel to the Phase 4 `Classifier`: `PromptAssembler.buildDraftPrompt` (drafter.md + voice guide + thread context + optional raw intent) → `GatewayClient.complete` (free text) → a versioned `drafts` row → SSE `draft:ready`. A generalized `SequentialQueue` (refactored from `ClassificationQueue`) serializes both classify and draft work on the single GPU. Send goes via the existing `ImapProvider.sendMessage`, translating the draft's internal `in_reply_to_message_id` to the replied-to message's RFC `Message-ID`, then flips the thread to `awaiting_their_reply`.

**Tech Stack:** TypeScript (NodeNext ESM, strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), `better-sqlite3-multiple-ciphers`, Fastify 5, `zod`, `vitest`.

---

## Conventions for this plan

- **Run the service suite:** `pnpm --filter @secretary/service test` (filter by filename substring, e.g. `... test drafter`).
- **Typecheck:** `pnpm --filter @secretary/service typecheck`. **Build:** `pnpm --filter @secretary/service build`.
- **Build shared-types after Task 1:** `pnpm --filter @secretary/shared-types build` — the service imports it from `dist/`; new types are invisible until rebuilt.
- ESM: `.js` import extensions intra-package; package name cross-package.
- Tests use `openDatabase(join(dir,'secretary.db'), new InMemorySecretStore())` (runs migrations + `seedSettings`); always `db.close()` before the `afterEach` `rmSync` (Windows lock).
- Commits: conventional; co-author trailer:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```
  In the Bash tool, commit with `git commit -F - <<'MSG' … MSG` (never `@'…'@`).
- The fake gateway helper already exists: `apps/service/test/helpers/fakeGateway.ts` (`FakeGateway` returns scripted `response` strings; for drafts the response is the free-text body).

---

## File Structure

**Create:**

- `apps/service/server/agent/draftDiff.ts` — pure line-level diff for `polish_diff`.
- `apps/service/server/agent/SequentialQueue.ts` — generic serial queue (replaces `ClassificationQueue.ts`).
- `apps/service/server/agent/Drafter.ts` — the draft orchestrator.
- `apps/service/server/db/repositories/DraftsRepository.ts` — drafts CRUD.
- `apps/service/server/db/repositories/StyleExamplesRepository.ts` — few-shot read (empty in v1).
- `apps/service/server/prompts/drafter.md`, `apps/service/server/prompts/voice-baseline.md`.
- `apps/service/server/api/drafts.ts` — the draft endpoints.
- Test files: `draft-diff.test.ts`, `sequential-queue.test.ts` (rewrite of `classification-queue.test.ts`), `drafts-repository.test.ts`, `style-examples-repository.test.ts`, `draft-prompt.test.ts`, `drafter.test.ts`, `drafts-routes.test.ts`.
- `docs/PHASE-5-MANUAL-VERIFICATION.md`.

**Modify:**

- `packages/shared-types/src/domain.ts` — `DraftStatus`, `DiffOp`, `DraftView`.
- `apps/service/server/db/schema.ts` — `DraftRow`, `StyleExampleRow`.
- `apps/service/server/agent/PromptAssembler.ts` — add `settings` + `styleExamples` deps + `buildDraftPrompt`.
- `apps/service/server/agent/Classifier.ts` — add `ContactsRepository` dep + `onDraftEligible?` hook.
- `apps/service/server/db/seed.ts` — `agent.autodraft_on_inbound` → `false`.
- `apps/service/server/server.ts` — `ServerDeps.drafter`; register drafts routes.
- `apps/service/server/index.ts` — build drafter + draft queue; wire the hook; use `SequentialQueue`.
- `apps/service/test/helpers/testServer.ts` — provide a `drafter`.
- `apps/service/test/classification-queue.test.ts` → delete (replaced by `sequential-queue.test.ts`).
- `apps/service/test/classifier.test.ts` — Classifier constructor change.
- `apps/service/test/prompt-assembler.test.ts` — PromptAssembler constructor change.
- `BRIEF.md` — Phase 5 deviations.

---

### Task 1: Shared types (draft view + status + diff op)

**Files:**

- Modify: `packages/shared-types/src/domain.ts`

- [ ] **Step 1: Add the types**

Append to `packages/shared-types/src/domain.ts`:

```typescript
export type DraftStatus = 'pending_review' | 'editing' | 'sent' | 'discarded' | 'failed';

/** One line of a raw-intent → polished-body diff (BRIEF §6 polish_diff). */
export interface DiffOp {
  op: 'eq' | 'add' | 'del';
  line: string;
}

/** A draft as returned by the drafts API (ISO dates per §16). */
export interface DraftView {
  id: string;
  threadId: string;
  accountId: string;
  version: number;
  to: EmailAddress[];
  cc: EmailAddress[];
  subject: string | null;
  bodyText: string;
  rawIntent: string | null;
  polishDiff: DiffOp[] | null;
  status: DraftStatus;
  modelUsed: string | null;
  createdAt: string | null;
  sentAt: string | null;
}
```

- [ ] **Step 2: Build shared-types**

Run: `pnpm --filter @secretary/shared-types build`
Expected: exit 0; `dist/domain.d.ts` contains `DraftView`, `DraftStatus`, `DiffOp`.

- [ ] **Step 3: Commit**

```bash
git add packages/shared-types/src/domain.ts packages/shared-types/dist
git commit -F - <<'MSG'
feat(shared-types): draft view, status, and diff-op types

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

(Note: `packages/shared-types/dist` is gitignored; the `git add … dist` may stage nothing — that's fine, commit the source only.)

---

### Task 2: Line-level diff util

**Files:**

- Create: `apps/service/server/agent/draftDiff.ts`
- Test: `apps/service/test/draft-diff.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/service/test/draft-diff.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { lineDiff } from '../server/agent/draftDiff.js';

describe('lineDiff', () => {
  it('marks identical text as all eq', () => {
    expect(lineDiff('a\nb', 'a\nb')).toEqual([
      { op: 'eq', line: 'a' },
      { op: 'eq', line: 'b' },
    ]);
  });

  it('detects an added line', () => {
    expect(lineDiff('a\nc', 'a\nb\nc')).toEqual([
      { op: 'eq', line: 'a' },
      { op: 'add', line: 'b' },
      { op: 'eq', line: 'c' },
    ]);
  });

  it('detects a removed line', () => {
    expect(lineDiff('a\nb\nc', 'a\nc')).toEqual([
      { op: 'eq', line: 'a' },
      { op: 'del', line: 'b' },
      { op: 'eq', line: 'c' },
    ]);
  });

  it('represents a full rewrite as del-then-add', () => {
    const d = lineDiff('old line', 'new line');
    expect(d).toEqual([
      { op: 'del', line: 'old line' },
      { op: 'add', line: 'new line' },
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @secretary/service test draft-diff`
Expected: FAIL — cannot find module `draftDiff.js`.

- [ ] **Step 3: Implement**

Create `apps/service/server/agent/draftDiff.ts`:

```typescript
import type { DiffOp } from '@secretary/shared-types';

/** Minimal LCS-based line diff. Pure. Returns an op-tagged line sequence. */
export function lineDiff(before: string, after: string): DiffOp[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;

  // dp[i][j] = LCS length of a[i:] and b[j:]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    const ai = a[i] as string;
    const row = dp[i] as number[];
    const nextRow = dp[i + 1] as number[];
    for (let j = m - 1; j >= 0; j -= 1) {
      row[j] =
        ai === (b[j] as string)
          ? (nextRow[j + 1] as number) + 1
          : Math.max(nextRow[j] as number, row[j + 1] as number);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if ((a[i] as string) === (b[j] as string)) {
      ops.push({ op: 'eq', line: a[i] as string });
      i += 1;
      j += 1;
    } else if ((dp[i + 1] as number[])[j]! >= (dp[i] as number[])[j + 1]!) {
      ops.push({ op: 'del', line: a[i] as string });
      i += 1;
    } else {
      ops.push({ op: 'add', line: b[j] as string });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ op: 'del', line: a[i] as string });
    i += 1;
  }
  while (j < m) {
    ops.push({ op: 'add', line: b[j] as string });
    j += 1;
  }
  return ops;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @secretary/service test draft-diff`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/service/server/agent/draftDiff.ts apps/service/test/draft-diff.test.ts
git commit -F - <<'MSG'
feat(service): line-level diff util for draft polish_diff

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 3: DraftRow + DraftsRepository

**Files:**

- Modify: `apps/service/server/db/schema.ts`
- Create: `apps/service/server/db/repositories/DraftsRepository.ts`
- Test: `apps/service/test/drafts-repository.test.ts`

- [ ] **Step 1: Add the row type**

In `apps/service/server/db/schema.ts`, append after `FollowUpRow`:

```typescript
export interface DraftRow {
  id: string;
  thread_id: string;
  account_id: string;
  version: number;
  in_reply_to_message_id: string | null;
  to_addresses: string | null;
  cc_addresses: string | null;
  subject: string | null;
  body_text: string;
  body_html: string | null;
  raw_intent: string | null;
  polish_diff: string | null;
  system_prompt_used: string | null;
  model_used: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  latency_ms: number | null;
  status: 'pending_review' | 'editing' | 'sent' | 'discarded' | 'failed';
  created_at: number | null;
  sent_at: number | null;
  final_body_sent: string | null;
}
```

- [ ] **Step 2: Write the failing test**

Create `apps/service/test/drafts-repository.test.ts`:

```typescript
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemorySecretStore } from '../server/auth/SecretStore.js';
import { openDatabase } from '../server/db/connection.js';
import { ThreadsRepository } from '../server/db/repositories/ThreadsRepository.js';
import { DraftsRepository } from '../server/db/repositories/DraftsRepository.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secretary-drafts-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
  db.prepare(
    `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','a@b.com')`,
  ).run();
  const threadId = new ThreadsRepository(db).create('acc1', 'hi', [], 1000);
  return { db, threadId };
}

function insertInput(threadId: string, version: number) {
  return {
    threadId,
    accountId: 'acc1',
    version,
    inReplyToMessageId: null,
    to: [{ address: 'alice@x.com' }],
    cc: [],
    subject: 'Re: hi',
    bodyText: 'Hello there.',
    rawIntent: null,
    polishDiff: null,
    systemPromptUsed: 'sys',
    modelUsed: 'm',
    tokensIn: 1,
    tokensOut: 2,
    latencyMs: 3,
    createdAt: 1000,
  };
}

describe('DraftsRepository', () => {
  it('inserts with incrementing versions and reads back', () => {
    const { db, threadId } = setup();
    const repo = new DraftsRepository(db);
    expect(repo.nextVersion(threadId)).toBe(1);
    const id1 = repo.insert(insertInput(threadId, repo.nextVersion(threadId)));
    expect(repo.nextVersion(threadId)).toBe(2);
    const id2 = repo.insert(insertInput(threadId, repo.nextVersion(threadId)));

    const d2 = repo.getById(id2)!;
    expect(d2.version).toBe(2);
    expect(d2.status).toBe('pending_review');
    expect(JSON.parse(d2.to_addresses!)).toEqual([{ address: 'alice@x.com' }]);
    expect(repo.latestForThread(threadId)?.id).toBe(id2);
    expect(repo.getById(id1)?.version).toBe(1);
    db.close();
  });

  it('updateBody, markSent, markDiscarded, markFailed', () => {
    const { db, threadId } = setup();
    const repo = new DraftsRepository(db);
    const id = repo.insert(insertInput(threadId, 1));

    repo.updateBody(id, { bodyText: 'Edited body.', subject: 'Re: hi (edited)' });
    let d = repo.getById(id)!;
    expect([d.body_text, d.subject]).toEqual(['Edited body.', 'Re: hi (edited)']);

    repo.markSent(id, { sentAt: 5000, finalBodySent: 'Edited body.' });
    d = repo.getById(id)!;
    expect([d.status, d.sent_at, d.final_body_sent]).toEqual(['sent', 5000, 'Edited body.']);

    const id2 = repo.insert(insertInput(threadId, 2));
    repo.markDiscarded(id2);
    expect(repo.getById(id2)?.status).toBe('discarded');
    // latestForThread skips discarded -> the sent v1 is the latest non-discarded
    expect(repo.latestForThread(threadId)?.id).toBe(id);

    const id3 = repo.insert(insertInput(threadId, 3));
    repo.markFailed(id3);
    expect(repo.getById(id3)?.status).toBe('failed');
    db.close();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @secretary/service test drafts-repository`
Expected: FAIL — cannot find module `DraftsRepository.js`.

- [ ] **Step 4: Implement**

Create `apps/service/server/db/repositories/DraftsRepository.ts`:

```typescript
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3-multiple-ciphers';
import type { DiffOp, EmailAddress } from '@secretary/shared-types';
import type { DraftRow } from '../schema.js';

export interface DraftInsert {
  threadId: string;
  accountId: string;
  version: number;
  inReplyToMessageId: string | null;
  to: EmailAddress[];
  cc: EmailAddress[];
  subject: string | null;
  bodyText: string;
  rawIntent: string | null;
  polishDiff: DiffOp[] | null;
  systemPromptUsed: string;
  modelUsed: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  createdAt: number;
}

export class DraftsRepository {
  constructor(private readonly db: Database.Database) {}

  /** The next version number for a thread (1-based). */
  nextVersion(threadId: string): number {
    const row = this.db
      .prepare('SELECT MAX(version) AS v FROM drafts WHERE thread_id = ?')
      .get(threadId) as { v: number | null };
    return (row.v ?? 0) + 1;
  }

  insert(input: DraftInsert): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO drafts
          (id, thread_id, account_id, version, in_reply_to_message_id, to_addresses, cc_addresses,
           subject, body_text, raw_intent, polish_diff, system_prompt_used, model_used,
           tokens_in, tokens_out, latency_ms, status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending_review', ?)`,
      )
      .run(
        id,
        input.threadId,
        input.accountId,
        input.version,
        input.inReplyToMessageId,
        JSON.stringify(input.to),
        JSON.stringify(input.cc),
        input.subject,
        input.bodyText,
        input.rawIntent,
        input.polishDiff ? JSON.stringify(input.polishDiff) : null,
        input.systemPromptUsed,
        input.modelUsed,
        input.tokensIn,
        input.tokensOut,
        input.latencyMs,
        input.createdAt,
      );
    return id;
  }

  getById(id: string): DraftRow | undefined {
    return this.db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as DraftRow | undefined;
  }

  /** Highest-version draft for a thread that hasn't been discarded. */
  latestForThread(threadId: string): DraftRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM drafts WHERE thread_id = ? AND status != 'discarded'
         ORDER BY version DESC LIMIT 1`,
      )
      .get(threadId) as DraftRow | undefined;
  }

  updateBody(id: string, fields: { bodyText?: string; subject?: string }): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (fields.bodyText !== undefined) {
      sets.push('body_text = ?');
      vals.push(fields.bodyText);
    }
    if (fields.subject !== undefined) {
      sets.push('subject = ?');
      vals.push(fields.subject);
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE drafts SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  }

  markSent(id: string, fields: { sentAt: number; finalBodySent: string }): void {
    this.db
      .prepare("UPDATE drafts SET status = 'sent', sent_at = ?, final_body_sent = ? WHERE id = ?")
      .run(fields.sentAt, fields.finalBodySent, id);
  }

  markDiscarded(id: string): void {
    this.db.prepare("UPDATE drafts SET status = 'discarded' WHERE id = ?").run(id);
  }

  markFailed(id: string): void {
    this.db.prepare("UPDATE drafts SET status = 'failed' WHERE id = ?").run(id);
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @secretary/service test drafts-repository`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/service/server/db/schema.ts apps/service/server/db/repositories/DraftsRepository.ts apps/service/test/drafts-repository.test.ts
git commit -F - <<'MSG'
feat(service): DraftsRepository + DraftRow

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 4: StyleExampleRow + StyleExamplesRepository

**Files:**

- Modify: `apps/service/server/db/schema.ts`
- Create: `apps/service/server/db/repositories/StyleExamplesRepository.ts`
- Test: `apps/service/test/style-examples-repository.test.ts`

- [ ] **Step 1: Add the row type**

In `apps/service/server/db/schema.ts`, append after `DraftRow`:

```typescript
export interface StyleExampleRow {
  id: string;
  source_message_id: string | null;
  contact_category: string | null;
  context_summary: string | null;
  reply_text: string | null;
  tags: string | null;
  embedding: Buffer | null;
}
```

- [ ] **Step 2: Write the failing test**

Create `apps/service/test/style-examples-repository.test.ts`:

```typescript
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @secretary/service test style-examples-repository`
Expected: FAIL — cannot find module `StyleExamplesRepository.js`.

- [ ] **Step 4: Implement**

Create `apps/service/server/db/repositories/StyleExamplesRepository.ts`:

```typescript
import type Database from 'better-sqlite3-multiple-ciphers';
import type { ContactCategory } from '@secretary/shared-types';
import type { StyleExampleRow } from '../schema.js';

export class StyleExamplesRepository {
  constructor(private readonly db: Database.Database) {}

  /** Up to `limit` examples for the category; falls back to any when none match. (Empty in v1.) */
  sample(category: ContactCategory, limit: number): StyleExampleRow[] {
    const matched = this.db
      .prepare('SELECT * FROM style_examples WHERE contact_category = ? LIMIT ?')
      .all(category, limit) as StyleExampleRow[];
    if (matched.length >= limit) return matched;
    if (matched.length > 0) return matched;
    return this.db.prepare('SELECT * FROM style_examples LIMIT ?').all(limit) as StyleExampleRow[];
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @secretary/service test style-examples-repository`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/service/server/db/schema.ts apps/service/server/db/repositories/StyleExamplesRepository.ts apps/service/test/style-examples-repository.test.ts
git commit -F - <<'MSG'
feat(service): StyleExamplesRepository + StyleExampleRow (few-shot read)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 5: Generalize ClassificationQueue → SequentialQueue

**Files:**

- Create: `apps/service/server/agent/SequentialQueue.ts`
- Delete: `apps/service/server/agent/ClassificationQueue.ts`
- Create: `apps/service/test/sequential-queue.test.ts`
- Delete: `apps/service/test/classification-queue.test.ts`
- Modify: `apps/service/server/index.ts` (the one `ClassificationQueue` usage)

- [ ] **Step 1: Write the new test (rewrite of the old)**

Create `apps/service/test/sequential-queue.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { SequentialQueue } from '../server/agent/SequentialQueue.js';

class Recorder {
  readonly order: string[] = [];
  private active = 0;
  maxConcurrent = 0;
  fn = async (id: string): Promise<void> => {
    this.active += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.active);
    await new Promise((r) => setTimeout(r, 1));
    this.order.push(id);
    this.active -= 1;
  };
}

describe('SequentialQueue', () => {
  it('drains FIFO with concurrency 1', async () => {
    const rec = new Recorder();
    const q = new SequentialQueue(rec.fn);
    q.enqueue('a');
    q.enqueue('b');
    q.enqueue('c');
    await q.onIdle();
    expect(rec.order).toEqual(['a', 'b', 'c']);
    expect(rec.maxConcurrent).toBe(1);
  });

  it('dedups an id already queued', async () => {
    const rec = new Recorder();
    const q = new SequentialQueue(rec.fn);
    q.enqueue('a');
    q.enqueue('a');
    await q.onIdle();
    expect(rec.order).toEqual(['a']);
  });

  it('onIdle resolves immediately when empty', async () => {
    await new SequentialQueue(async () => {}).onIdle();
    expect(true).toBe(true);
  });

  it('keeps draining when a job throws', async () => {
    const order: string[] = [];
    const q = new SequentialQueue(async (id) => {
      if (id === 'bad') throw new Error('boom');
      order.push(id);
    });
    q.enqueue('bad');
    q.enqueue('good');
    await q.onIdle();
    expect(order).toEqual(['good']);
  });

  it('picks up an item enqueued while a job is in progress', async () => {
    let resolveFirst!: () => void;
    const order: string[] = [];
    const q = new SequentialQueue(async (id) => {
      if (id === 'first')
        await new Promise<void>((r) => {
          resolveFirst = r;
        });
      order.push(id);
    });
    q.enqueue('first');
    await Promise.resolve();
    q.enqueue('second');
    resolveFirst();
    await q.onIdle();
    expect(order).toEqual(['first', 'second']);
  });
});
```

- [ ] **Step 2: Delete the old test + run to verify the new one fails**

```bash
git rm apps/service/test/classification-queue.test.ts
```

Run: `pnpm --filter @secretary/service test sequential-queue`
Expected: FAIL — cannot find module `SequentialQueue.js`.

- [ ] **Step 3: Implement SequentialQueue, delete ClassificationQueue**

Create `apps/service/server/agent/SequentialQueue.ts`:

```typescript
/** A worker processes one id at a time; it should be self-contained (not throw). */
export type SequentialWorker = (id: string) => Promise<void>;

/** In-process FIFO queue draining one job at a time (single-GPU friendliness). */
export class SequentialQueue {
  private readonly order: string[] = [];
  private readonly queued = new Set<string>();
  private draining = false;
  private idleResolvers: Array<() => void> = [];

  constructor(private readonly worker: SequentialWorker) {}

  enqueue(id: string): void {
    if (this.queued.has(id)) return;
    this.queued.add(id);
    this.order.push(id);
    void this.drain();
  }

  /** Number of pending (not-yet-started) items; the in-flight job is not counted. */
  size(): number {
    return this.order.length;
  }

  /** Resolves when the queue is empty and idle. */
  onIdle(): Promise<void> {
    if (!this.draining && this.order.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        const id = this.order.shift();
        if (id === undefined) break;
        try {
          await this.worker(id);
        } catch (err) {
          // Workers are expected to be self-contained; backstop so a contract-violating
          // throw can't stall the drain loop or vanish silently.
          console.error(
            `[secretary] sequential-queue job failed (${id}):`,
            err instanceof Error ? err.message : err,
          );
        }
        this.queued.delete(id);
      }
    } finally {
      this.draining = false;
      const resolvers = this.idleResolvers;
      this.idleResolvers = [];
      for (const resolve of resolvers) resolve();
    }
  }
}
```

```bash
git rm apps/service/server/agent/ClassificationQueue.ts
```

- [ ] **Step 4: Update the `index.ts` usage**

In `apps/service/server/index.ts`, change the import:

```typescript
import { SequentialQueue } from './agent/SequentialQueue.js';
```

(remove the `import { ClassificationQueue } ...` line)

And the construction:

```typescript
const classificationQueue = new SequentialQueue((id) => classifier.classify(id));
```

(`buildServer`'s `classificationQueue` dep is typed `{ enqueue(messageId: string): void }`, which `SequentialQueue` satisfies — no other change needed.)

- [ ] **Step 5: Run the suite to verify it passes**

Run: `pnpm --filter @secretary/service test sequential-queue` → PASS (5 tests).
Run: `pnpm --filter @secretary/service test` → all green.
Run: `pnpm --filter @secretary/service typecheck` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A apps/service/server/agent apps/service/test apps/service/server/index.ts
git commit -F - <<'MSG'
refactor(service): generalize ClassificationQueue into SequentialQueue

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 6: Drafter prompts (`drafter.md`, `voice-baseline.md`)

**Files:**

- Create: `apps/service/server/prompts/drafter.md`
- Create: `apps/service/server/prompts/voice-baseline.md`

- [ ] **Step 1: Write `drafter.md`**

Create `apps/service/server/prompts/drafter.md`:

```markdown
You write email replies on behalf of the principal (the person whose inbox this is). You are given context about the contact, the recent thread, the specific message to reply to, and sometimes the principal's dictated intent.

Write a reply that:

- Is in the principal's voice (see the voice guide below).
- Directly addresses the message being replied to and any intent the principal gave.
- Matches the requested tone and length.
- Is ready to send: a natural salutation, the body, and a brief sign-off — nothing else.

Output rules:

- Return ONLY the email body text. No subject line. No "Subject:" prefix. No quoted original message. No commentary or notes to the principal.
- If the principal provided an intent, polish and expand it into a complete reply rather than restating it verbatim.
- Keep it to the requested length. Prefer clarity and warmth over length.
```

- [ ] **Step 2: Write `voice-baseline.md`**

Create `apps/service/server/prompts/voice-baseline.md`:

```markdown
## Voice guide (baseline)

- Warm but concise. Friendly and human, not stiff or corporate.
- Plain language. Short sentences. No jargon or filler.
- Direct: answer the question or make the ask in the first sentence or two.
- Polite sign-off ("Thanks," / "Best,") followed by the principal's first name placeholder — do not invent a name; end with "Thanks," on its own line if unsure.
- Never over-promise, never commit to dates/prices unless they appear in the context.
```

- [ ] **Step 3: Verify the prompts ship in the build**

The existing service build already copies `server/prompts` → `dist/server/prompts` (added in Phase 4), so both `.md` files ship automatically. Confirm:

Run: `pnpm --filter @secretary/service build`
Then: `node -e "const fs=require('node:fs'); for (const f of ['drafter.md','voice-baseline.md']) { if(!fs.existsSync('apps/service/dist/server/prompts/'+f)) { console.error('MISSING '+f); process.exit(1);} } console.log('prompts shipped')"`
Expected: prints `prompts shipped`.

- [ ] **Step 4: Commit**

```bash
git add apps/service/server/prompts/drafter.md apps/service/server/prompts/voice-baseline.md
git commit -F - <<'MSG'
feat(service): drafter system prompt + baseline voice guide

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 7: PromptAssembler.buildDraftPrompt

**Files:**

- Modify: `apps/service/server/agent/PromptAssembler.ts`
- Modify: `apps/service/test/prompt-assembler.test.ts`
- Test: `apps/service/test/draft-prompt.test.ts`

This adds two constructor deps (`settings`, `styleExamples`) — so the three existing `new PromptAssembler(...)` call sites must update: `index.ts`, `prompt-assembler.test.ts`, and `classifier.test.ts` (its `makeClassifier` helper). Steps 4–6 handle those.

- [ ] **Step 1: Write the failing test**

Create `apps/service/test/draft-prompt.test.ts`:

```typescript
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RawMessage } from '@secretary/shared-types';
import { InMemorySecretStore } from '../server/auth/SecretStore.js';
import { openDatabase } from '../server/db/connection.js';
import { ContactsRepository } from '../server/db/repositories/ContactsRepository.js';
import { MessagesRepository } from '../server/db/repositories/MessagesRepository.js';
import { SettingsRepository } from '../server/db/repositories/SettingsRepository.js';
import { StyleExamplesRepository } from '../server/db/repositories/StyleExamplesRepository.js';
import { ThreadsRepository } from '../server/db/repositories/ThreadsRepository.js';
import { PromptAssembler } from '../server/agent/PromptAssembler.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secretary-dp-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function inbound(uid: string, body: string, when: number): RawMessage {
  return {
    providerId: uid,
    references: [],
    from: { address: 'alice@x.com', name: 'Alice' },
    to: [{ address: 'me@b.com' }],
    cc: [],
    bcc: [],
    subject: 'Can we meet?',
    bodyText: body,
    snippet: body.slice(0, 200),
    direction: 'inbound',
    dateReceived: when,
    isRead: false,
    isStarred: false,
    folder: 'INBOX',
    labels: [],
    attachmentsMeta: [],
  };
}

function make(db: ReturnType<typeof openDatabase>): PromptAssembler {
  return new PromptAssembler(
    new MessagesRepository(db),
    new ThreadsRepository(db),
    new ContactsRepository(db),
    new SettingsRepository(db),
    new StyleExamplesRepository(db),
  );
}

describe('PromptAssembler.buildDraftPrompt', () => {
  it('assembles system (drafter.md + voice guide) + the message to reply to + raw intent', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','a@b.com')`,
    ).run();
    const threads = new ThreadsRepository(db);
    const messages = new MessagesRepository(db);
    const contacts = new ContactsRepository(db);
    const threadId = threads.create('acc1', 'can we meet', ['alice@x.com'], 1000);
    contacts.recordSeen({ address: 'alice@x.com', name: 'Alice' }, 'inbound', 1000);
    messages.insert('acc1', threadId, inbound('u1', 'Are you free Tuesday?', 1000));

    const { system, prompt, systemPromptUsed } = make(db).buildDraftPrompt(threadId, {
      rawIntent: 'yes, tuesday 2pm works',
    });
    db.close();

    expect(system).toContain('Return ONLY the email body'); // drafter.md
    expect(system).toContain('Voice guide'); // voice-baseline.md
    expect(systemPromptUsed).toBe(system);
    expect(prompt).toContain('Are you free Tuesday?'); // the message to reply to
    expect(prompt).toContain('yes, tuesday 2pm works'); // raw intent
    expect(prompt).toContain('Tone:');
  });

  it('uses the style_guide setting override when set', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','a@b.com')`,
    ).run();
    const threads = new ThreadsRepository(db);
    const messages = new MessagesRepository(db);
    const threadId = threads.create('acc1', 'x', [], 1000);
    messages.insert('acc1', threadId, inbound('u1', 'hi', 1000));
    new SettingsRepository(db).set('style_guide', 'CUSTOM VOICE GUIDE MARKER');

    const { system } = make(db).buildDraftPrompt(threadId);
    db.close();
    expect(system).toContain('CUSTOM VOICE GUIDE MARKER');
    expect(system).not.toContain('Voice guide (baseline)');
  });

  it('throws when the thread has no inbound message to reply to', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','a@b.com')`,
    ).run();
    const threadId = new ThreadsRepository(db).create('acc1', 'x', [], 1000);
    expect(() => make(db).buildDraftPrompt(threadId)).toThrow(/no inbound message/i);
    db.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @secretary/service test draft-prompt`
Expected: FAIL — `PromptAssembler` constructor takes 3 deps (no settings/styleExamples) and `buildDraftPrompt` is not a function.

- [ ] **Step 3: Implement the PromptAssembler changes**

Replace `apps/service/server/agent/PromptAssembler.ts` with:

```typescript
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NotFoundError, ValidationError, type ContactCategory } from '@secretary/shared-types';
import type { ContactsRepository } from '../db/repositories/ContactsRepository.js';
import type { MessagesRepository } from '../db/repositories/MessagesRepository.js';
import type { SettingsRepository } from '../db/repositories/SettingsRepository.js';
import type { StyleExamplesRepository } from '../db/repositories/StyleExamplesRepository.js';
import type { ThreadsRepository } from '../db/repositories/ThreadsRepository.js';
import { normalizeSubject } from '../sync/threading.js';

const CONTACT_NOTES_MAX = 500;
const SNIPPET_MAX = 200;
const BODY_MAX = 2000;
const DRAFT_BODY_MAX = 4000;
const CONTEXT_MESSAGES = 3;
const FEW_SHOT = 3;

const here = dirname(fileURLToPath(import.meta.url));

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…[truncated]`;
}

const TONE: Record<ContactCategory, string> = {
  client_established: 'warm and professional',
  client_new: 'warm, professional, and welcoming',
  screening: 'polite, brief, and a little cautious',
  personal: 'casual and friendly',
  vendor: 'brief and professional',
  noise: 'brief and professional',
  unknown: 'warm and professional',
};

export class PromptAssembler {
  private classifierSystem: string | null = null;
  private drafterSystem: string | null = null;
  private voiceBaseline: string | null = null;

  constructor(
    private readonly messages: MessagesRepository,
    private readonly threads: ThreadsRepository,
    private readonly contacts: ContactsRepository,
    private readonly settings: SettingsRepository,
    private readonly styleExamples: StyleExamplesRepository,
    private readonly promptsDir: string = join(here, '..', 'prompts'),
  ) {}

  private classifierSystemPrompt(): string {
    if (this.classifierSystem === null) {
      this.classifierSystem = readFileSync(join(this.promptsDir, 'classifier.md'), 'utf8');
    }
    return this.classifierSystem;
  }

  private drafterSystemPrompt(): string {
    if (this.drafterSystem === null) {
      this.drafterSystem = readFileSync(join(this.promptsDir, 'drafter.md'), 'utf8');
    }
    return this.drafterSystem;
  }

  private voiceGuide(): string {
    const override = this.settings.get<string>('style_guide');
    if (typeof override === 'string' && override.trim().length > 0) return override;
    if (this.voiceBaseline === null) {
      this.voiceBaseline = readFileSync(join(this.promptsDir, 'voice-baseline.md'), 'utf8');
    }
    return this.voiceBaseline;
  }

  buildClassificationPrompt(messageId: string): { system: string; prompt: string } {
    const message = this.messages.getById(messageId);
    if (!message) throw new NotFoundError('Message not found');
    const contact = this.contacts.findByEmail(message.from_address);
    const prior = this.messages
      .listByThread(message.thread_id)
      .filter((m) => m.id !== messageId)
      .slice(-CONTEXT_MESSAGES);

    const lines: string[] = [];
    lines.push('## Contact');
    lines.push(`Name: ${contact?.display_name ?? message.from_name ?? message.from_address}`);
    lines.push(`Category: ${contact?.category ?? 'unknown'}`);
    if (contact?.notes) lines.push(`Notes: ${truncate(contact.notes, CONTACT_NOTES_MAX)}`);
    lines.push('');

    if (prior.length > 0) {
      lines.push('## Recent thread context (chronological)');
      for (const m of prior) {
        const body = truncate(m.snippet ?? m.body_text ?? '', SNIPPET_MAX);
        lines.push(`- ${m.direction} · ${m.from_address} · ${body}`);
      }
      lines.push('');
    }

    lines.push('## New message');
    lines.push(`Subject: ${message.subject ?? '(no subject)'}`);
    lines.push('Body:');
    lines.push(truncate(message.body_text ?? '', BODY_MAX));
    lines.push('');
    lines.push(
      'Return ONLY a JSON object with keys: intent, category_suggestion, urgency, requires_response, summary.',
    );

    return { system: this.classifierSystemPrompt(), prompt: lines.join('\n') };
  }

  buildDraftPrompt(
    threadId: string,
    opts?: { rawIntent?: string },
  ): { system: string; prompt: string; systemPromptUsed: string } {
    const thread = this.threads.get(threadId);
    if (!thread) throw new NotFoundError('Thread not found');
    const target = this.messages.latestInboundForThread(threadId);
    if (!target) throw new ValidationError('No inbound message to reply to');
    const contact = this.contacts.findByEmail(target.from_address);
    const category: ContactCategory = contact?.category ?? 'unknown';
    const system = `${this.drafterSystemPrompt()}\n\n${this.voiceGuide()}`;

    const lines: string[] = [];
    lines.push('## Contact');
    lines.push(`Name: ${contact?.display_name ?? target.from_name ?? target.from_address}`);
    lines.push(`Category: ${category}`);
    if (contact?.notes) lines.push(`Notes: ${truncate(contact.notes, CONTACT_NOTES_MAX)}`);
    if (contact?.style_notes) {
      lines.push(`Style notes: ${truncate(contact.style_notes, CONTACT_NOTES_MAX)}`);
    }
    lines.push('');

    lines.push('## Tone & length');
    lines.push(`Tone: ${TONE[category]}`);
    lines.push('Length: 1-3 short paragraphs.');
    lines.push('');

    const examples = this.styleExamples.sample(category, FEW_SHOT);
    if (examples.length > 0) {
      lines.push('## Style examples (match this voice)');
      for (const ex of examples) {
        lines.push(`Context: ${truncate(ex.context_summary ?? '', SNIPPET_MAX)}`);
        lines.push(`Reply: ${truncate(ex.reply_text ?? '', BODY_MAX)}`);
        lines.push('');
      }
    }

    const prior = this.messages
      .listByThread(threadId)
      .filter((m) => m.id !== target.id)
      .slice(-CONTEXT_MESSAGES);
    if (prior.length > 0) {
      lines.push('## Thread history (chronological)');
      for (const m of prior) {
        lines.push(
          `- ${m.direction} · ${m.from_address} · ${truncate(m.snippet ?? m.body_text ?? '', SNIPPET_MAX)}`,
        );
      }
      lines.push('');
    }

    lines.push('## Message to reply to');
    lines.push(`From: ${target.from_name ?? target.from_address} <${target.from_address}>`);
    lines.push(`Subject: ${target.subject ?? '(no subject)'}`);
    lines.push('Body:');
    lines.push(truncate(target.body_text ?? '', DRAFT_BODY_MAX));
    lines.push('');

    if (opts?.rawIntent) {
      lines.push("## Principal's intent (polish this into the reply)");
      lines.push(opts.rawIntent);
      lines.push('');
    }

    lines.push('Write only the reply body — no subject line, no quoted original.');

    return { system, prompt: lines.join('\n'), systemPromptUsed: system };
  }
}

/** Re-export for the Drafter to reuse the same Re: normalization. */
export function replySubject(subject: string | null): string {
  const norm = normalizeSubject(subject ?? undefined);
  const base = subject && subject.trim().length > 0 ? subject.trim() : '(no subject)';
  return /^re:/i.test(base) ? base : `Re: ${norm.length > 0 ? subject!.trim() : '(no subject)'}`;
}
```

(`replySubject` lives here so the Drafter and PromptAssembler share the `Re:` rule; it uses the existing `normalizeSubject` only to detect emptiness — the visible subject keeps original casing with a single `Re:` prefix.)

- [ ] **Step 4: Update `prompt-assembler.test.ts`**

In `apps/service/test/prompt-assembler.test.ts`, the test constructs `new PromptAssembler(messages, threads, contacts)`. Add the two new deps. Add imports:

```typescript
import { SettingsRepository } from '../server/db/repositories/SettingsRepository.js';
import { StyleExamplesRepository } from '../server/db/repositories/StyleExamplesRepository.js';
```

and change EVERY `new PromptAssembler(messages, threads, contacts)` (and the missing-message test's inline construction) to:

```typescript
new PromptAssembler(
  messages,
  threads,
  contacts,
  new SettingsRepository(db),
  new StyleExamplesRepository(db),
);
```

(use the local `messages`/`threads`/`contacts`/`db` variables already in each test).

- [ ] **Step 5: Update `classifier.test.ts`'s PromptAssembler construction**

In `apps/service/test/classifier.test.ts`, the `makeClassifier` helper builds `new PromptAssembler(ctx.messages, ctx.threads, contacts)`. Add the two deps (it already has `settings` and a `db` via `ctx.db`):

```typescript
import { StyleExamplesRepository } from '../server/db/repositories/StyleExamplesRepository.js';
// ...
const prompts = new PromptAssembler(
  ctx.messages,
  ctx.threads,
  contacts,
  settings,
  new StyleExamplesRepository(ctx.db),
);
```

- [ ] **Step 6: Update `index.ts`'s PromptAssembler construction**

In `apps/service/server/index.ts`, add the import + a repo, and extend the construction:

```typescript
import { StyleExamplesRepository } from './db/repositories/StyleExamplesRepository.js';
// in the Repositories block:
const styleExamplesRepo = new StyleExamplesRepository(db);
// change the promptAssembler line:
const promptAssembler = new PromptAssembler(
  messagesRepo,
  threadsRepo,
  contactsRepo,
  settingsRepo,
  styleExamplesRepo,
);
```

- [ ] **Step 7: Run tests + typecheck to verify green**

Run: `pnpm --filter @secretary/service test draft-prompt` → PASS.
Run: `pnpm --filter @secretary/service test` → all green (prompt-assembler + classifier suites still pass with the new constructor).
Run: `pnpm --filter @secretary/service typecheck` → exit 0.

- [ ] **Step 8: Commit**

```bash
git add apps/service/server/agent/PromptAssembler.ts apps/service/server/index.ts apps/service/test/prompt-assembler.test.ts apps/service/test/classifier.test.ts apps/service/test/draft-prompt.test.ts
git commit -F - <<'MSG'
feat(service): PromptAssembler.buildDraftPrompt + voice-guide loading

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 8: Drafter

**Files:**

- Create: `apps/service/server/agent/Drafter.ts`
- Test: `apps/service/test/drafter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/service/test/drafter.test.ts`:

```typescript
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RawMessage } from '@secretary/shared-types';
import { InMemorySecretStore } from '../server/auth/SecretStore.js';
import { openDatabase } from '../server/db/connection.js';
import { ActionLogRepository } from '../server/db/repositories/ActionLogRepository.js';
import { ContactsRepository } from '../server/db/repositories/ContactsRepository.js';
import { DraftsRepository } from '../server/db/repositories/DraftsRepository.js';
import { MessagesRepository } from '../server/db/repositories/MessagesRepository.js';
import { SettingsRepository } from '../server/db/repositories/SettingsRepository.js';
import { StyleExamplesRepository } from '../server/db/repositories/StyleExamplesRepository.js';
import { ThreadsRepository } from '../server/db/repositories/ThreadsRepository.js';
import { EventBus } from '../server/eventBus.js';
import { PromptAssembler } from '../server/agent/PromptAssembler.js';
import { Drafter } from '../server/agent/Drafter.js';
import { FakeGateway, ThrowingGateway } from './helpers/fakeGateway.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secretary-drafter-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const NOOP_LOG = { info() {}, warn() {} };

function inbound(uid: string, body: string, when: number): RawMessage {
  return {
    providerId: uid,
    references: [],
    messageIdHeader: `<${uid}@x>`,
    from: { address: 'alice@x.com', name: 'Alice' },
    to: [{ address: 'me@b.com' }],
    cc: [],
    bcc: [],
    subject: 'Can we meet?',
    bodyText: body,
    snippet: body.slice(0, 200),
    direction: 'inbound',
    dateReceived: when,
    isRead: false,
    isStarred: false,
    folder: 'INBOX',
    labels: [],
    attachmentsMeta: [],
  };
}

interface Ctx {
  db: ReturnType<typeof openDatabase>;
  drafts: DraftsRepository;
  threadId: string;
  messageId: string;
}

function seed(): Ctx {
  const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
  db.prepare(
    `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','a@b.com')`,
  ).run();
  const threads = new ThreadsRepository(db);
  const messages = new MessagesRepository(db);
  const contacts = new ContactsRepository(db);
  const threadId = threads.create('acc1', 'can we meet', ['alice@x.com'], 1000);
  contacts.recordSeen({ address: 'alice@x.com', name: 'Alice' }, 'inbound', 1000);
  const messageId = messages.insert(
    'acc1',
    threadId,
    inbound('u1', 'Are you free Tuesday?', 1000),
  )!;
  return { db, drafts: new DraftsRepository(db), threadId, messageId };
}

function makeDrafter(ctx: Ctx, gateway: FakeGateway | ThrowingGateway | null): Drafter {
  const settings = new SettingsRepository(ctx.db);
  const prompts = new PromptAssembler(
    new MessagesRepository(ctx.db),
    new ThreadsRepository(ctx.db),
    new ContactsRepository(ctx.db),
    settings,
    new StyleExamplesRepository(ctx.db),
  );
  return new Drafter(
    prompts,
    gateway,
    ctx.drafts,
    new MessagesRepository(ctx.db),
    new ThreadsRepository(ctx.db),
    new ActionLogRepository(ctx.db),
    new EventBus(),
    settings,
    NOOP_LOG,
    () => 5000,
  );
}

describe('Drafter.draft', () => {
  it('writes a pending_review draft with derived recipients + metadata, emits draft:ready', async () => {
    const ctx = seed();
    const events: unknown[] = [];
    const drafter = makeDrafter(
      ctx,
      new FakeGateway(['Tuesday at 2pm works great. See you then.']),
    );
    // capture SSE by re-wiring a bus is awkward; instead assert via the returned row + repo.
    const row = await drafter.draft(ctx.threadId);
    ctx.db.close();
    expect(row).not.toBeNull();
    expect(row!.version).toBe(1);
    expect(row!.status).toBe('pending_review');
    expect(row!.body_text).toBe('Tuesday at 2pm works great. See you then.');
    expect(JSON.parse(row!.to_addresses!)).toEqual([{ address: 'alice@x.com', name: 'Alice' }]);
    expect(row!.subject).toBe('Re: Can we meet?');
    expect(row!.in_reply_to_message_id).toBe(ctx.messageId);
    expect(row!.model_used).toBeTruthy();
    void events;
  });

  it('computes polish_diff when rawIntent is given', async () => {
    const ctx = seed();
    const drafter = makeDrafter(ctx, new FakeGateway(['Yes — Tuesday at 2pm works.']));
    const row = await drafter.draft(ctx.threadId, { rawIntent: 'tuesday 2pm ok' });
    ctx.db.close();
    expect(row!.raw_intent).toBe('tuesday 2pm ok');
    expect(JSON.parse(row!.polish_diff!).length).toBeGreaterThan(0);
  });

  it('bumps the version on a second draft', async () => {
    const ctx = seed();
    const drafter = makeDrafter(ctx, new FakeGateway(['v1', 'v2']));
    await drafter.draft(ctx.threadId);
    const second = await drafter.draft(ctx.threadId);
    ctx.db.close();
    expect(second!.version).toBe(2);
  });

  it('returns null + logs draft_failed when the gateway is null', async () => {
    const ctx = seed();
    const row = await makeDrafter(ctx, null).draft(ctx.threadId);
    const n = (ctx.db.prepare('SELECT COUNT(*) AS n FROM drafts').get() as { n: number }).n;
    ctx.db.close();
    expect(row).toBeNull();
    expect(n).toBe(0);
  });

  it('returns null + records draft_failed when the gateway throws', async () => {
    const ctx = seed();
    const row = await makeDrafter(ctx, new ThrowingGateway()).draft(ctx.threadId);
    const failed = (
      ctx.db.prepare("SELECT COUNT(*) AS n FROM action_log WHERE action='draft_failed'").get() as {
        n: number;
      }
    ).n;
    ctx.db.close();
    expect(row).toBeNull();
    expect(failed).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @secretary/service test drafter`
Expected: FAIL — cannot find module `Drafter.js`.

- [ ] **Step 3: Implement**

Create `apps/service/server/agent/Drafter.ts`:

```typescript
import type { ActionLogRepository } from '../db/repositories/ActionLogRepository.js';
import type { DraftsRepository } from '../db/repositories/DraftsRepository.js';
import type { MessagesRepository } from '../db/repositories/MessagesRepository.js';
import type { SettingsRepository } from '../db/repositories/SettingsRepository.js';
import type { ThreadsRepository } from '../db/repositories/ThreadsRepository.js';
import type { GatewayClient } from '../llm/GatewayClient.js';
import type { EventBus } from '../eventBus.js';
import type { DraftRow } from '../db/schema.js';
import type { MiniLogger } from './Classifier.js';
import { PromptAssembler, replySubject } from './PromptAssembler.js';
import { lineDiff } from './draftDiff.js';

const DEFAULT_MODEL = 'qwen2.5:14b-instruct-q5_K_M';
const DEFAULT_DRAFT_TEMPERATURE = 0.5;
const MAX_TOKENS = 800;

/** Strips a stray leading "Subject:" line and surrounding whitespace a model might add. */
function cleanBody(raw: string): string {
  return raw.replace(/^\s*subject:.*\n+/i, '').trim();
}

export class Drafter {
  constructor(
    private readonly prompts: PromptAssembler,
    private readonly gateway: GatewayClient | null,
    private readonly drafts: DraftsRepository,
    private readonly messages: MessagesRepository,
    private readonly threads: ThreadsRepository,
    private readonly actions: ActionLogRepository,
    private readonly eventBus: EventBus,
    private readonly settings: SettingsRepository,
    private readonly log: MiniLogger,
    private readonly now: () => number = Date.now,
  ) {}

  /** Draft a reply for a thread's latest inbound message. Never throws (queue-safe). */
  async draft(threadId: string, opts?: { rawIntent?: string }): Promise<DraftRow | null> {
    if (!this.gateway) {
      this.log.warn({ threadId }, 'gateway not configured; skipping draft');
      return null;
    }
    const thread = this.threads.get(threadId);
    if (!thread) return null;
    const target = this.messages.latestInboundForThread(threadId);
    if (!target) {
      this.log.warn({ threadId }, 'no inbound message to reply to; skipping draft');
      return null;
    }

    try {
      const { prompt, systemPromptUsed } = this.prompts.buildDraftPrompt(
        threadId,
        opts?.rawIntent ? { rawIntent: opts.rawIntent } : undefined,
      );
      const model = this.settings.get<string>('llm.model') ?? DEFAULT_MODEL;
      const temperature =
        this.settings.get<number>('llm.temperature.draft') ?? DEFAULT_DRAFT_TEMPERATURE;
      const res = await this.gateway.complete({
        model,
        system: systemPromptUsed,
        prompt,
        temperature,
        max_tokens: MAX_TOKENS,
      });
      const body = cleanBody(res.response);
      const rawIntent = opts?.rawIntent ?? null;
      const polishDiff = rawIntent ? lineDiff(rawIntent, body) : null;

      const id = this.drafts.insert({
        threadId,
        accountId: thread.account_id,
        version: this.drafts.nextVersion(threadId),
        inReplyToMessageId: target.id,
        to: target.from_name
          ? [{ address: target.from_address, name: target.from_name }]
          : [{ address: target.from_address }],
        cc: [],
        subject: replySubject(target.subject),
        bodyText: body,
        rawIntent,
        polishDiff,
        systemPromptUsed,
        modelUsed: res.model,
        tokensIn: res.tokens_in,
        tokensOut: res.tokens_out,
        latencyMs: res.duration_ms,
        createdAt: this.now(),
      });
      const row = this.drafts.getById(id) ?? null;
      this.actions.append({
        actor: 'agent',
        action: 'draft_created',
        targetType: 'draft',
        targetId: id,
        details: { threadId, version: row?.version, regenerate: opts !== undefined },
      });
      this.eventBus.emit({
        type: 'draft:ready',
        payload: { threadId, draftId: id, accountId: thread.account_id },
      });
      return row;
    } catch (err) {
      this.log.warn(
        { threadId, err: err instanceof Error ? err.message : 'unknown' },
        'draft generation error',
      );
      this.actions.append({
        actor: 'agent',
        action: 'draft_failed',
        targetType: 'thread',
        targetId: threadId,
      });
      return null;
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @secretary/service test drafter`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/service/server/agent/Drafter.ts apps/service/test/drafter.test.ts
git commit -F - <<'MSG'
feat(service): Drafter — assemble, complete, write versioned draft, emit draft:ready

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 9: Classifier auto-draft eligibility hook

**Files:**

- Modify: `apps/service/server/agent/Classifier.ts`
- Modify: `apps/service/test/classifier.test.ts`
- Modify: `apps/service/server/index.ts` (pass `contactsRepo` to the Classifier)

- [ ] **Step 1: Write the failing tests**

In `apps/service/test/classifier.test.ts`, update `makeClassifier` to accept an optional draft-hook capture and pass the new deps, then add eligibility tests. Change the `makeClassifier` signature + body to:

```typescript
function makeClassifier(
  ctx: Ctx,
  gateway: FakeGateway | ThrowingGateway | null,
  onDraftEligible?: (threadId: string) => void,
): Classifier {
  const settings = new SettingsRepository(ctx.db);
  const contacts = new ContactsRepository(ctx.db);
  const eventBus = new EventBus();
  const stateMachine = new StateMachine(
    ctx.threads,
    contacts,
    settings,
    ctx.actions,
    eventBus,
    () => 10_000,
  );
  const prompts = new PromptAssembler(
    ctx.messages,
    ctx.threads,
    contacts,
    settings,
    new StyleExamplesRepository(ctx.db),
  );
  return new Classifier(
    prompts,
    gateway,
    stateMachine,
    ctx.threads,
    ctx.messages,
    ctx.actions,
    eventBus,
    settings,
    contacts,
    NOOP_LOG,
    () => 10_000,
    onDraftEligible,
  );
}
```

(add `import { StyleExamplesRepository } from '../server/db/repositories/StyleExamplesRepository.js';` and `import { ContactsRepository } from ...` if not already imported.)

Append these tests:

```typescript
describe('Classifier auto-draft eligibility', () => {
  it('fires onDraftEligible when requires_response + autodraft_on_inbound + not do_not_auto_draft', async () => {
    const ctx = seed();
    new SettingsRepository(ctx.db).set('agent.autodraft_on_inbound', true);
    const eligible: string[] = [];
    const gw = new FakeGateway([
      '{"requires_response":true,"urgency":"normal","summary":"needs reply"}',
    ]);
    await makeClassifier(ctx, gw, (id) => eligible.push(id)).classify(ctx.messageId);
    ctx.db.close();
    expect(eligible).toEqual([ctx.threadId]);
  });

  it('does NOT fire when requires_response is false', async () => {
    const ctx = seed();
    new SettingsRepository(ctx.db).set('agent.autodraft_on_inbound', true);
    const eligible: string[] = [];
    const gw = new FakeGateway(['{"requires_response":false,"summary":"fyi"}']);
    await makeClassifier(ctx, gw, (id) => eligible.push(id)).classify(ctx.messageId);
    ctx.db.close();
    expect(eligible).toEqual([]);
  });

  it('does NOT fire when autodraft_on_inbound is false', async () => {
    const ctx = seed();
    new SettingsRepository(ctx.db).set('agent.autodraft_on_inbound', false);
    const eligible: string[] = [];
    const gw = new FakeGateway(['{"requires_response":true,"summary":"x"}']);
    await makeClassifier(ctx, gw, (id) => eligible.push(id)).classify(ctx.messageId);
    ctx.db.close();
    expect(eligible).toEqual([]);
  });

  it('does NOT fire when the contact is do_not_auto_draft', async () => {
    const ctx = seed();
    new SettingsRepository(ctx.db).set('agent.autodraft_on_inbound', true);
    const contacts = new ContactsRepository(ctx.db);
    contacts.patch(contacts.findByEmail('alice@x.com')!.id, { doNotAutoDraft: true });
    const eligible: string[] = [];
    const gw = new FakeGateway(['{"requires_response":true,"summary":"x"}']);
    await makeClassifier(ctx, gw, (id) => eligible.push(id)).classify(ctx.messageId);
    ctx.db.close();
    expect(eligible).toEqual([]);
  });
});
```

(The `seed()` helper in this file records the contact `alice@x.com`; confirm it does — the Phase 4 test's `seed()` calls `contacts.recordSeen({ address: 'alice@x.com', name: 'Alice' }, 'inbound', 1000)`. It does.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @secretary/service test classifier`
Expected: FAIL — `Classifier` constructor has no `contacts`/`onDraftEligible` params; eligibility not fired.

- [ ] **Step 3: Implement the Classifier changes**

In `apps/service/server/agent/Classifier.ts`:

Add the import:

```typescript
import type { ContactsRepository } from '../db/repositories/ContactsRepository.js';
```

Add two constructor params (after `log`, before `now` — but `now` has a default, so place `contacts` before `log` and `onDraftEligible` last to keep defaults valid). Use this exact constructor:

```typescript
  constructor(
    private readonly prompts: PromptAssembler,
    private readonly gateway: GatewayClient | null,
    private readonly stateMachine: StateMachine,
    private readonly threads: ThreadsRepository,
    private readonly messages: MessagesRepository,
    private readonly actions: ActionLogRepository,
    private readonly eventBus: EventBus,
    private readonly settings: SettingsRepository,
    private readonly contacts: ContactsRepository,
    private readonly log: MiniLogger,
    private readonly now: () => number = Date.now,
    private readonly onDraftEligible?: (threadId: string) => void,
  ) {}
```

In `classify`, after the `eventBus.emit({ type: 'thread:updated', ... })` success line (before the `catch`), add the auto-draft eligibility check:

```typescript
if (result.requires_response && this.onDraftEligible) {
  const autodraft = this.settings.get<boolean>('agent.autodraft_on_inbound') === true;
  const contact = this.contacts.findByEmail(message.from_address);
  if (autodraft && contact?.do_not_auto_draft !== 1) {
    this.onDraftEligible(threadId);
  }
}
```

- [ ] **Step 4: Update `index.ts` Classifier construction**

In `apps/service/server/index.ts`, the Classifier is built with 9 args ending in `log`. Add `contactsRepo` before `log`:

```typescript
const classifier = new Classifier(
  promptAssembler,
  gateway,
  stateMachine,
  threadsRepo,
  messagesRepo,
  actionsRepo,
  eventBus,
  settingsRepo,
  contactsRepo,
  log,
);
```

(The `onDraftEligible` hook is wired in Task 11; omitted here so the build stays green meanwhile — the auto-draft path is inert until then, which is correct since `autodraft_on_inbound` defaults to false anyway.)

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter @secretary/service test classifier` → PASS (existing 5 + 4 new eligibility).
Run: `pnpm --filter @secretary/service test` → all green.
Run: `pnpm --filter @secretary/service typecheck` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/service/server/agent/Classifier.ts apps/service/server/index.ts apps/service/test/classifier.test.ts
git commit -F - <<'MSG'
feat(service): Classifier auto-draft eligibility hook (gated, off by default)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 10: Drafts API

**Files:**

- Create: `apps/service/server/api/drafts.ts`
- Modify: `apps/service/server/server.ts` (ServerDeps + register)
- Modify: `apps/service/test/helpers/testServer.ts` (provide a `drafter`)
- Test: `apps/service/test/drafts-routes.test.ts`

- [ ] **Step 1: Extend `ServerDeps` + the test helper**

In `apps/service/server/server.ts`:

- Add to imports: `import type { DraftRow } from './db/schema.js';` is NOT needed; instead add the drafter type inline. Add to `ServerDeps` (after `stateMachine`):

```typescript
  /** Synchronously generate a draft for a thread (manual create/regenerate). */
  drafter: { draft(threadId: string, opts?: { rawIntent?: string }): Promise<import('./db/schema.js').DraftRow | null> };
```

- Add the import + registration in the `/api/v1` block:

```typescript
import { registerDraftsRoutes } from './api/drafts.js';
// ...inside the register block, after registerContactsRoutes(api, deps);
registerDraftsRoutes(api, deps);
```

In `apps/service/test/helpers/testServer.ts`, build a real `Drafter` backed by a `FakeGateway` and expose it. Add imports:

```typescript
import { Drafter } from '../../server/agent/Drafter.js';
import { DraftsRepository } from '../../server/db/repositories/DraftsRepository.js';
import { StyleExamplesRepository } from '../../server/db/repositories/StyleExamplesRepository.js';
import { PromptAssembler } from '../../server/agent/PromptAssembler.js';
import { MessagesRepository } from '../../server/db/repositories/MessagesRepository.js';
import { SettingsRepository } from '../../server/db/repositories/SettingsRepository.js';
import { FakeGateway } from './fakeGateway.js';
```

(some of these may already be imported for the stateMachine wiring — dedup.)

Add a `draftBody` option + build the drafter (place after the `stateMachine` construction):

```typescript
const drafterPrompts = new PromptAssembler(
  new MessagesRepository(db),
  new ThreadsRepository(db),
  new ContactsRepository(db),
  new SettingsRepository(db),
  new StyleExamplesRepository(db),
);
const drafter = new Drafter(
  drafterPrompts,
  new FakeGateway([opts.draftBody ?? 'Drafted reply body.']),
  new DraftsRepository(db),
  new MessagesRepository(db),
  new ThreadsRepository(db),
  new ActionLogRepository(db),
  eventBus,
  new SettingsRepository(db),
  { info() {}, warn() {} },
);
```

Add `draftBody?: string` to the `makeTestServer` opts type; add `drafter` to the `buildServer({...})` deps and to the `TestServer` interface + returned object.

- [ ] **Step 2: Write the failing route tests**

Create `apps/service/test/drafts-routes.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { makeTestServer, type TestServer } from './helpers/testServer.js';

describe('drafts routes', () => {
  function insertThreadWithInbound(db: TestServer['db']) {
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','a@b.com')`,
    ).run();
    db.prepare(
      `INSERT INTO threads (id, account_id, subject_normalized, participants, message_count, last_message_at, last_inbound_at, state)
       VALUES ('t1','acc1','can we meet','[]',1,1000,1000,'awaiting_your_reply')`,
    ).run();
    db.prepare(
      `INSERT INTO messages (id, account_id, provider_id, thread_id, message_id_header, from_address, from_name, direction, date_received, subject)
       VALUES ('m1','acc1','u1','t1','<u1@x>','alice@x.com','Alice','inbound',1000,'Can we meet?')`,
    ).run();
  }

  it('POST /drafts creates a draft synchronously, GET returns it, PATCH edits it', async () => {
    const { app, session, db } = await makeTestServer({ draftBody: 'Tuesday works.' });
    insertThreadWithInbound(db);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/drafts',
      headers: { authorization: `Bearer ${session}` },
      payload: { threadId: 't1' },
    });
    expect(created.statusCode).toBe(200);
    const draft = created.json().data;
    expect(draft.bodyText).toBe('Tuesday works.');
    expect(draft.subject).toBe('Re: Can we meet?');
    expect(draft.to[0].address).toBe('alice@x.com');
    expect(draft.status).toBe('pending_review');

    const got = await app.inject({
      method: 'GET',
      url: `/api/v1/drafts/${draft.id}`,
      headers: { authorization: `Bearer ${session}` },
    });
    expect(got.json().data.id).toBe(draft.id);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/drafts/${draft.id}`,
      headers: { authorization: `Bearer ${session}` },
      payload: { bodyText: 'Tuesday 2pm works.' },
    });
    expect(patched.json().data.bodyText).toBe('Tuesday 2pm works.');
    await app.close();
  });

  it('POST /drafts/:id/send sends the edited body, sets threading header, flips thread to awaiting_their_reply', async () => {
    const { app, session, db, providers } = await makeTestServer({ draftBody: 'Original.' });
    insertThreadWithInbound(db);
    // Register a fake provider for the account so send() resolves it.
    const { FakeEmailProvider } = await import('./helpers/fakeProvider.js');
    const provider = new FakeEmailProvider('acc1', []);
    providers.set(provider);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/drafts',
      headers: { authorization: `Bearer ${session}` },
      payload: { threadId: 't1' },
    });
    const id = created.json().data.id;
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/drafts/${id}`,
      headers: { authorization: `Bearer ${session}` },
      payload: { bodyText: 'Edited final.' },
    });

    const sent = await app.inject({
      method: 'POST',
      url: `/api/v1/drafts/${id}/send`,
      headers: { authorization: `Bearer ${session}` },
      payload: {},
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().data.threadState).toBe('awaiting_their_reply');

    const draftRow = db
      .prepare('SELECT status, final_body_sent FROM drafts WHERE id = ?')
      .get(id) as {
      status: string;
      final_body_sent: string;
    };
    const threadRow = db.prepare("SELECT state FROM threads WHERE id='t1'").get() as {
      state: string;
    };
    expect(draftRow.status).toBe('sent');
    expect(draftRow.final_body_sent).toBe('Edited final.');
    expect(threadRow.state).toBe('awaiting_their_reply');
    expect(provider.lastSend?.inReplyToMessageId).toBe('<u1@x>'); // RFC Message-ID, not internal id
    await app.close();
  });

  it('DELETE /drafts/:id discards; POST /drafts/:id/send on a discarded draft is 400', async () => {
    const { app, session, db } = await makeTestServer({ draftBody: 'x' });
    insertThreadWithInbound(db);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/drafts',
      headers: { authorization: `Bearer ${session}` },
      payload: { threadId: 't1' },
    });
    const id = created.json().data.id;
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/drafts/${id}`,
      headers: { authorization: `Bearer ${session}` },
    });
    expect(del.json().data.discarded).toBe(true);
    const send = await app.inject({
      method: 'POST',
      url: `/api/v1/drafts/${id}/send`,
      headers: { authorization: `Bearer ${session}` },
      payload: {},
    });
    expect(send.statusCode).toBe(400);
    await app.close();
  });

  it('GET unknown draft -> 404', async () => {
    const { app, session } = await makeTestServer();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/drafts/nope',
      headers: { authorization: `Bearer ${session}` },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
```

This test references `provider.lastSend` — add that capture to the fake provider (Step 3).

- [ ] **Step 3: Add `lastSend` capture to the fake provider**

In `apps/service/test/helpers/fakeProvider.ts`, record the last `SendInput`. Add a public field and set it in `sendMessage`:

```typescript
  lastSend: SendInput | null = null;
  // ...
  async sendMessage(input: SendInput): Promise<{ providerMessageId: string }> {
    this.lastSend = input;
    this.sendCount += 1;
    return { providerMessageId: `fake-${this.sendCount}` };
  }
```

(`SendInput` is already imported in that file.)

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pnpm --filter @secretary/service test drafts-routes`
Expected: FAIL — `/api/v1/drafts` 404 (routes not registered) / `drafter` undefined on the test server.

- [ ] **Step 5: Implement the drafts routes**

Create `apps/service/server/api/drafts.ts`:

```typescript
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3-multiple-ciphers';
import { z } from 'zod';
import {
  NotFoundError,
  UpstreamError,
  ValidationError,
  type DraftView,
  type EmailAddress,
  type DiffOp,
  type ThreadState,
} from '@secretary/shared-types';
import { DraftsRepository } from '../db/repositories/DraftsRepository.js';
import { MessagesRepository } from '../db/repositories/MessagesRepository.js';
import type { DraftRow } from '../db/schema.js';
import type { ProviderRegistry } from '../providers/ProviderRegistry.js';

const createSchema = z
  .object({
    threadId: z.string().min(1),
    rawIntent: z.string().optional(),
    regenerate: z.boolean().optional(),
  })
  .strict();
const patchSchema = z
  .object({ bodyText: z.string().optional(), subject: z.string().optional() })
  .strict();

function parseAddrs(json: string | null): EmailAddress[] {
  if (!json) return [];
  try {
    return JSON.parse(json) as EmailAddress[];
  } catch {
    return [];
  }
}

function draftView(row: DraftRow): DraftView {
  return {
    id: row.id,
    threadId: row.thread_id,
    accountId: row.account_id,
    version: row.version,
    to: parseAddrs(row.to_addresses),
    cc: parseAddrs(row.cc_addresses),
    subject: row.subject,
    bodyText: row.body_text,
    rawIntent: row.raw_intent,
    polishDiff: row.polish_diff ? (JSON.parse(row.polish_diff) as DiffOp[]) : null,
    status: row.status,
    modelUsed: row.model_used,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    sentAt: row.sent_at ? new Date(row.sent_at).toISOString() : null,
  };
}

export interface DraftsRouteDeps {
  db: Database.Database;
  drafter: { draft(threadId: string, opts?: { rawIntent?: string }): Promise<DraftRow | null> };
  providers: ProviderRegistry;
  stateMachine: { onOutbound(threadId: string): void };
}

export function registerDraftsRoutes(app: FastifyInstance, deps: DraftsRouteDeps): void {
  const drafts = new DraftsRepository(deps.db);
  const messages = new MessagesRepository(deps.db);

  app.get('/drafts/:id', async (req) => {
    const { id } = req.params as { id: string };
    const row = drafts.getById(id);
    if (!row) throw new NotFoundError('Draft not found');
    return { data: draftView(row) };
  });

  app.post('/drafts', async (req) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid draft request');
    const row = await deps.drafter.draft(
      parsed.data.threadId,
      parsed.data.rawIntent !== undefined ? { rawIntent: parsed.data.rawIntent } : undefined,
    );
    if (!row) throw new UpstreamError('draft_failed', 'Draft generation failed', 502);
    return { data: draftView(row) };
  });

  app.patch('/drafts/:id', async (req) => {
    const { id } = req.params as { id: string };
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid draft patch');
    if (!drafts.getById(id)) throw new NotFoundError('Draft not found');
    drafts.updateBody(id, parsed.data);
    return { data: draftView(drafts.getById(id)!) };
  });

  app.post('/drafts/:id/send', async (req) => {
    const { id } = req.params as { id: string };
    const draft = drafts.getById(id);
    if (!draft) throw new NotFoundError('Draft not found');
    if (draft.status === 'sent' || draft.status === 'discarded') {
      throw new ValidationError(`Draft is already ${draft.status}`);
    }
    const provider = deps.providers.get(draft.account_id);
    if (!provider) throw new NotFoundError('Account not connected');

    const replyToHeader = draft.in_reply_to_message_id
      ? (messages.getById(draft.in_reply_to_message_id)?.message_id_header ?? undefined)
      : undefined;
    const to = parseAddrs(draft.to_addresses);
    const cc = parseAddrs(draft.cc_addresses);
    const input = {
      to,
      bodyText: draft.body_text,
      ...(cc.length > 0 ? { cc } : {}),
      ...(draft.subject ? { subject: draft.subject } : {}),
      ...(replyToHeader ? { inReplyToMessageId: replyToHeader } : {}),
    };
    let providerMessageId: string;
    try {
      ({ providerMessageId } = await provider.sendMessage(input));
    } catch (err) {
      drafts.markFailed(id);
      throw new UpstreamError(
        'send_failed',
        err instanceof Error ? err.message : 'Send failed',
        502,
      );
    }
    drafts.markSent(id, { sentAt: Date.now(), finalBodySent: draft.body_text });
    deps.stateMachine.onOutbound(draft.thread_id);
    return {
      data: { providerMessageId, threadState: 'awaiting_their_reply' as ThreadState },
    };
  });

  app.delete('/drafts/:id', async (req) => {
    const { id } = req.params as { id: string };
    if (!drafts.getById(id)) throw new NotFoundError('Draft not found');
    drafts.markDiscarded(id);
    return { data: { discarded: true } };
  });
}
```

Note: `onOutbound` already appends its own `state_outbound` action-log + SSE; the send route relies on that for the thread:updated event. The draft `draft_sent` audit is optional and omitted to avoid duplicate logging — `markSent` + `onOutbound`'s log cover it.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @secretary/service test drafts-routes` → PASS (4 tests).
Run: `pnpm --filter @secretary/service test` → all green.
Run: `pnpm --filter @secretary/service typecheck` → exit 0.

- [ ] **Step 7: Commit**

```bash
git add apps/service/server/api/drafts.ts apps/service/server/server.ts apps/service/test/helpers/testServer.ts apps/service/test/helpers/fakeProvider.ts apps/service/test/drafts-routes.test.ts
git commit -F - <<'MSG'
feat(service): drafts API — create/get/edit/send/discard

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 11: Wire the Drafter + draft queue in index.ts; flip autodraft default

**Files:**

- Modify: `apps/service/server/index.ts`
- Modify: `apps/service/server/db/seed.ts`

- [ ] **Step 1: Flip the seed default**

In `apps/service/server/db/seed.ts`, change:

```typescript
  'agent.autodraft_on_inbound': true,
```

to:

```typescript
  'agent.autodraft_on_inbound': false,
```

- [ ] **Step 2: Wire the Drafter + draft queue + the Classifier hook**

In `apps/service/server/index.ts`:

Add imports:

```typescript
import { DraftsRepository } from './db/repositories/DraftsRepository.js';
import { Drafter } from './agent/Drafter.js';
```

(`StyleExamplesRepository`, `SequentialQueue` are already imported from Tasks 5 + 7.)

In the Repositories block, add:

```typescript
const draftsRepo = new DraftsRepository(db);
```

After the `classifier` + `classificationQueue` construction, build the drafter + its queue, and wire the hook. Because `onDraftEligible` is the LAST Classifier constructor arg and the queue must exist first, restructure so the draft queue is created before the Classifier, OR pass a late-bound closure. Use a late-bound closure to avoid ordering churn:

Replace the Classifier construction to include the hook, and create the drafter/queue right after `promptAssembler`:

```typescript
const drafter = new Drafter(
  promptAssembler,
  gateway,
  draftsRepo,
  messagesRepo,
  threadsRepo,
  actionsRepo,
  eventBus,
  settingsRepo,
  log,
);
const draftQueue = new SequentialQueue((threadId) => drafter.draft(threadId).then(() => undefined));

const classifier = new Classifier(
  promptAssembler,
  gateway,
  stateMachine,
  threadsRepo,
  messagesRepo,
  actionsRepo,
  eventBus,
  settingsRepo,
  contactsRepo,
  log,
  Date.now,
  (threadId) => draftQueue.enqueue(threadId),
);
const classificationQueue = new SequentialQueue((id) => classifier.classify(id));
```

(Note: the Classifier's `now` param is positional before `onDraftEligible`, so pass `Date.now` explicitly to reach the hook arg.)

Add `drafter` to the `buildServer({...})` deps object:

```typescript
    drafter,
```

- [ ] **Step 3: Typecheck + build + suite**

Run: `pnpm --filter @secretary/service typecheck` → exit 0.
Run: `pnpm --filter @secretary/service test` → all green (note: the `settings-repository` / seed-related tests, if any assert `autodraft_on_inbound`, update them — search: `pnpm --filter @secretary/service test -- --reporter dot` and grep for failures; if `seed`/settings tests assert the old `true`, fix them to `false`).
Run: `pnpm --filter @secretary/service build` → exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/service/server/index.ts apps/service/server/db/seed.ts
git commit -F - <<'MSG'
feat(service): wire Drafter + draft queue; autodraft_on_inbound defaults off

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 12: BRIEF.md deviations

**Files:**

- Modify: `BRIEF.md`

- [ ] **Step 1: Add a note at the end of the "Drafting job" subsection of §11**

Find the end of the "### Drafting job" subsection (before "### State transition rules (§11.1)") and insert:

```markdown
**Phase 5 implementation notes:**

- The Classifier→draft hook (step 4 above) is built but **gated**: it fires only when `agent.autodraft_on_inbound` is `true` AND the contact is not `do_not_auto_draft`. The seeded default for `agent.autodraft_on_inbound` is **`false`** (changed from `true`) so drafting is on-demand until enabled.
- **Manual draft creation (`POST /drafts`) is synchronous** — it awaits the LLM and returns the finished draft. Only the auto path is queued (a shared `SequentialQueue` serializes all classify + draft LLM calls on the single GPU).
- Replies address the **sender of the latest inbound message only** (v1; not reply-all); subject is `Re: <subject>`; threading uses that message's RFC `Message-ID`.
- `polish_diff` is a line-level diff (raw intent → polished body), stored as JSON.
```

- [ ] **Step 2: Add a note to §6 `settings` defaults**

Find the pre-populated `settings` keys list in §6 and update the `agent.autodraft_on_inbound` line annotation:

Change:

```markdown
- `agent.autodraft_on_inbound` = `true`
```

to:

```markdown
- `agent.autodraft_on_inbound` = `false` (Phase 5: shipped off; auto-draft hook is built but dormant until enabled)
```

- [ ] **Step 3: Commit**

```bash
git add BRIEF.md
git commit -F - <<'MSG'
docs(brief): record Phase 5 drafting decisions (autodraft default off, sync create)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 13: Manual verification runbook

**Files:**

- Create: `docs/PHASE-5-MANUAL-VERIFICATION.md`

- [ ] **Step 1: Write the runbook**

Create `docs/PHASE-5-MANUAL-VERIFICATION.md`:

````markdown
# Phase 5 — Manual Verification (Drafting + Review + Send)

The automated suite covers the Drafter (fake gateway), the draft prompt, the diff util,
DraftsRepository, the auto-draft eligibility hook, and the draft routes. This runbook verifies
real draft generation + send end-to-end. PowerShell from `C:\Users\drice\Secretary`.

## Prerequisites

- Same as Phase 4: Node-ABI SQLite, HTTPS certs, the Gmail test account added, and the operator
  gateway running pointed at Ollama (start it with `GATEWAY_API_KEY`/`PAYLOAD_ENCRYPTION_KEY`
  matching the keychain and `OLLAMA_DEFAULT_MODEL=<your model>`).
- The service's `llm.model` set to your pulled model. Drafting uses `llm.temperature.draft` (0.5).
- For no-body POSTs, PowerShell needs `-ContentType 'application/json' -Body '{}'` (see Phase 4 note).

## 1. Start the service + session token

```powershell
$env:LOG_PRETTY = 'true'
pnpm --filter @secretary/service dev:server
```

Second terminal:

```powershell
$BOOT = (Get-Content "$env:USERPROFILE\.secretary\bootstrap-token.txt" -Raw).Trim()
$T = (Invoke-RestMethod -Method Post -Uri https://localhost:47824/api/v1/auth/session `
  -ContentType 'application/json' -Body (@{ bootstrapToken = $BOOT } | ConvertTo-Json)).data.token
$H = @{ authorization = "Bearer $T" }
```

Confirm `autodraft_on_inbound` is off (on-demand drafting):

```powershell
Invoke-RestMethod -Method Patch -Uri https://localhost:47824/api/v1/settings `
  -Headers $H -ContentType 'application/json' -Body (@{ 'agent.autodraft_on_inbound' = $false } | ConvertTo-Json)
```

## 2. Create a draft on demand

Pick a thread that needs a reply:

```powershell
$TH = (Invoke-RestMethod -Uri https://localhost:47824/api/v1/threads/needs-attention -Headers $H).data[0].id
$draft = (Invoke-RestMethod -Method Post -Uri https://localhost:47824/api/v1/drafts `
  -Headers $H -ContentType 'application/json' -Body (@{ threadId = $TH } | ConvertTo-Json)).data
$draft | Format-List version, subject, status, @{n='to';e={$_.to.address}}, bodyText
```

Expect a `pending_review` draft, `Re: <subject>`, addressed to the inbound sender, with an
LLM-written body. (Quality is rough on the 1.5B model; that's expected.)

With a dictated intent (polish + diff):

```powershell
$d2 = (Invoke-RestMethod -Method Post -Uri https://localhost:47824/api/v1/drafts `
  -Headers $H -ContentType 'application/json' -Body (@{ threadId = $TH; rawIntent = 'politely decline, suggest next month' } | ConvertTo-Json)).data
$d2.polishDiff | Format-Table op, line
```

## 3. Edit + send

```powershell
Invoke-RestMethod -Method Patch -Uri "https://localhost:47824/api/v1/drafts/$($draft.id)" `
  -Headers $H -ContentType 'application/json' -Body (@{ bodyText = 'Edited final body. — sending test' } | ConvertTo-Json)

Invoke-RestMethod -Method Post -Uri "https://localhost:47824/api/v1/drafts/$($draft.id)/send" `
  -Headers $H -ContentType 'application/json' -Body '{}'
```

Expect `{ providerMessageId, threadState: 'awaiting_their_reply' }`. Confirm the email arrives at the
recipient, and the thread is now `awaiting_their_reply`:

```powershell
(Invoke-RestMethod -Uri "https://localhost:47824/api/v1/threads/$TH" -Headers $H).data.state
```

## 4. (Optional) Verify the auto-draft path

```powershell
Invoke-RestMethod -Method Patch -Uri https://localhost:47824/api/v1/settings `
  -Headers $H -ContentType 'application/json' -Body (@{ 'agent.autodraft_on_inbound' = $true } | ConvertTo-Json)
# Re-classify a thread that needs a response; within a few seconds a draft should appear.
Invoke-RestMethod -Method Post -Uri "https://localhost:47824/api/v1/threads/$TH/classify" `
  -Headers $H -ContentType 'application/json' -Body '{}'
```

(Then flip it back to `$false` if you want on-demand again.)

## Acceptance (BRIEF §14 Phase 5)

- New inbound (eligible) generates a draft (auto path, step 4) / on-demand (step 2). ✅
- Draft sent via the provider (step 3). ✅
- After send, thread → `awaiting_their_reply` (step 3). ✅
- Editing inline and sending uses the edited body (step 3 — `final_body_sent`). ✅
````

- [ ] **Step 2: Commit**

```bash
git add docs/PHASE-5-MANUAL-VERIFICATION.md
git commit -F - <<'MSG'
docs: Phase 5 manual verification runbook

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 14: Full green sweep

**Files:** none (verification + fixups)

- [ ] **Step 1: Whole-workspace tests**

Run: `pnpm -r test`
Expected: all packages green (shared-types, shared-crypto, llm-protocol, gateway, service). If a pre-existing seed/settings test asserted `autodraft_on_inbound = true`, fix it to `false`.

- [ ] **Step 2: Typecheck**

Run: `pnpm -r typecheck` → exit 0.

- [ ] **Step 3: Lint + format**

Run: `pnpm -r lint` → fix any issues in the new Phase 5 files properly (no blanket disables; the `as string`/`as number` bounded-access casts in `draftDiff.ts` are justified under `noUncheckedIndexedAccess` — add a short comment if flagged).
Run: `pnpm format` → leaves the tree clean.

- [ ] **Step 4: Build**

Run: `pnpm --filter @secretary/service build` → exit 0 (confirms prompts copy + compile).

- [ ] **Step 5: Commit fixups (skip if none)**

```bash
git add -A
git commit -F - <<'MSG'
chore(service): lint/format fixups for Phase 5

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

## Notes for the implementer

- **Build `@secretary/shared-types` (Task 1) before running service tests** — the service resolves it from `dist/`.
- **Native module ABI:** tests/`dev:server` need the Node-ABI build of `better-sqlite3-multiple-ciphers`.
- **Windows temp DBs:** `db.close()` before `afterEach` `rmSync`.
- The `Drafter` and `Classifier` never log message bodies, prompts, or completions (BRIEF §5) — `action_log` details carry only ids/enums/version numbers; the LLM prompt crossing to the gateway is the intended payload, never logged.
- `MiniLogger` is imported (type-only) from `Classifier.ts` by the `Drafter` — that's a deliberate shared type, not runtime coupling.
