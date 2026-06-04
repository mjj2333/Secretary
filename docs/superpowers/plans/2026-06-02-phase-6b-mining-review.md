# Phase 6b — Sent-Mail Mining + Review + Heavy-Edit Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add heavy-edit detection on send, a one-time sent-mail mining job that extracts pending style examples, and a PWA review/approve screen — completing BRIEF §14 Phase 6.

**Architecture:** One migration (`0002`) adds `style_examples.status` and `drafts.generated_body_text`. Heavy-edit detection compares the agent's preserved original body against the sent body via a word-level `divergenceRatio` and logs `draft_heavily_edited` (ids + ratio only). Mining runs on a third `SequentialQueue` lane (`SentMailMiner`), writing `pending` examples that only feed drafts once approved through the new `/voice/examples` screen. Spec: `docs/superpowers/specs/2026-06-02-phase-6b-mining-review-design.md`.

**Tech Stack:** TypeScript (strict, NodeNext ESM, `.js` import extensions), Fastify 5, better-sqlite3-multiple-ciphers, Vitest, zod; PWA: React 18 + Vite + Tailwind + Wouter + TanStack Query.

**Branch:** `feat/phase-6b-mining-review` (already created & checked out; spec committed).

**Conventions (match existing code):**
- Run all server tests from `apps/service`: `pnpm --filter @secretary/service test -- <file>` (or `pnpm --filter @secretary/service test` for all). PWA: `pnpm --filter @secretary/pwa test`.
- `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` are on — index accesses need `!`/casts; optional props are added conditionally.
- Repos take a `Database.Database` in the constructor; tests open a temp encrypted DB with `openDatabase(join(dir,'secretary.db'), new InMemorySecretStore())` (migrations run automatically).
- Action log details must contain **only ids/enums/counts — never message bodies** (BRIEF §5).
- Commit after each task with the co-author trailer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## Part A — Heavy-edit detection (independent, build first)

### Task 1: Migration 0002 + schema row types

**Files:**
- Create: `apps/service/server/db/migrations/0002_phase_6b.sql`
- Modify: `apps/service/server/db/migrations/index.ts`
- Modify: `apps/service/server/db/schema.ts` (`StyleExampleRow`, `DraftRow`, add `StyleExampleStatus`)
- Test: `apps/service/test/schema-migration.test.ts` (add cases)

- [ ] **Step 1: Write the failing test**

Add to `apps/service/test/schema-migration.test.ts` (inside the existing top-level `describe`, or append a new one — match the file's existing imports for `openDatabase`/`InMemorySecretStore`/temp dir):

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemorySecretStore } from '../server/auth/SecretStore.js';
import { openDatabase } from '../server/db/connection.js';

describe('migration 0002 (phase 6b)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'secretary-mig2-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds style_examples.status (default approved) and drafts.generated_body_text', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    db.prepare(
      `INSERT INTO style_examples (id, contact_category, context_summary, reply_text) VALUES ('s1','vendor','c','r')`,
    ).run();
    const ex = db.prepare("SELECT status FROM style_examples WHERE id='s1'").get() as {
      status: string;
    };
    const cols = (db.prepare('PRAGMA table_info(drafts)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    db.close();
    expect(ex.status).toBe('approved'); // default keeps a hand-inserted row usable
    expect(cols).toContain('generated_body_text');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @secretary/service test -- schema-migration`
Expected: FAIL — `no such column: status` (the migration doesn't exist yet).

- [ ] **Step 3: Create the migration SQL**

Create `apps/service/server/db/migrations/0002_phase_6b.sql`:

```sql
-- Phase 6b: review status for mined style examples + the agent's original generated draft body.
ALTER TABLE style_examples ADD COLUMN status TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE drafts ADD COLUMN generated_body_text TEXT;
```

- [ ] **Step 4: Register the migration**

In `apps/service/server/db/migrations/index.ts`, change the last line:

```ts
export const migrations: Migration[] = [load(1, 'init'), load(2, 'phase_6b')];
```

- [ ] **Step 5: Update the schema row types**

In `apps/service/server/db/schema.ts`:

Add the status type (place it just above `StyleExampleRow`):

```ts
export type StyleExampleStatus = 'pending' | 'approved' | 'rejected';
```

Add `status` to `StyleExampleRow`:

```ts
export interface StyleExampleRow {
  id: string;
  source_message_id: string | null;
  contact_category: string | null;
  context_summary: string | null;
  reply_text: string | null;
  tags: string | null;
  embedding: Buffer | null;
  status: StyleExampleStatus;
}
```

Add `generated_body_text` to `DraftRow` (after `body_text`):

```ts
  body_text: string;
  generated_body_text: string | null;
  body_html: string | null;
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @secretary/service test -- schema-migration`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/service/server/db/migrations/0002_phase_6b.sql apps/service/server/db/migrations/index.ts apps/service/server/db/schema.ts apps/service/test/schema-migration.test.ts
git commit -m "feat(6b): migration 0002 — style_examples.status + drafts.generated_body_text"
```

---

### Task 2: `divergenceRatio` helper

**Files:**
- Modify: `apps/service/server/agent/draftDiff.ts` (add `divergenceRatio` + `MAX_DIVERGENCE_WORDS`)
- Test: `apps/service/test/draft-diff.test.ts` (add a `describe`)

- [ ] **Step 1: Write the failing test**

Append to `apps/service/test/draft-diff.test.ts`:

```ts
import { divergenceRatio } from '../server/agent/draftDiff.js';

describe('divergenceRatio', () => {
  it('is 0 for identical text', () => {
    expect(divergenceRatio('the quick brown fox', 'the quick brown fox')).toBe(0);
  });

  it('is 1 for fully disjoint text', () => {
    expect(divergenceRatio('alpha beta gamma', 'one two three four')).toBe(1);
  });

  it('is below 0.30 for a one-word change in many', () => {
    const gen = 'the quick brown fox jumps over the lazy dog today';
    const sent = 'the quick brown fox jumps over the lazy dog tonight';
    expect(divergenceRatio(gen, sent)).toBeLessThan(0.3);
  });

  it('is 0 when both are empty', () => {
    expect(divergenceRatio('', '')).toBe(0);
    expect(divergenceRatio('   ', '')).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @secretary/service test -- draft-diff`
Expected: FAIL — `divergenceRatio is not a function`.

- [ ] **Step 3: Implement `divergenceRatio`**

Append to `apps/service/server/agent/draftDiff.ts`:

```ts
/** Cap inputs so the O(n·m) LCS stays bounded on pathological bodies. */
const MAX_DIVERGENCE_WORDS = 2000;

/**
 * Word-level divergence in [0,1]: 0 = identical, 1 = no shared words.
 * `1 - 2·LCS / (genWords + sentWords)` over whitespace-split words.
 * Both-empty → 0. Used to flag heavily-edited drafts on send.
 */
export function divergenceRatio(generated: string, finalSent: string): number {
  const a = generated.trim().split(/\s+/).filter(Boolean).slice(0, MAX_DIVERGENCE_WORDS);
  const b = finalSent.trim().split(/\s+/).filter(Boolean).slice(0, MAX_DIVERGENCE_WORDS);
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return 0;
  // dp[i][j] = LCS length of a[i:] and b[j:]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] =
        a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const lcs = dp[0]![0]!;
  const ratio = 1 - (2 * lcs) / (n + m);
  return Math.min(1, Math.max(0, ratio));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @secretary/service test -- draft-diff`
Expected: PASS (both `lineDiff` and `divergenceRatio` describes green).

- [ ] **Step 5: Commit**

```bash
git add apps/service/server/agent/draftDiff.ts apps/service/test/draft-diff.test.ts
git commit -m "feat(6b): word-level divergenceRatio helper"
```

---

### Task 3: Preserve the generated body (`DraftsRepository` + `Drafter`)

**Files:**
- Modify: `apps/service/server/db/repositories/DraftsRepository.ts` (`DraftInsert`, `insert`)
- Modify: `apps/service/server/agent/Drafter.ts` (pass `generatedBodyText`)
- Test: `apps/service/test/drafts-repository.test.ts` (add a case)

- [ ] **Step 1: Write the failing test**

Add to `apps/service/test/drafts-repository.test.ts` (mirror the existing insert test's setup; it constructs a `DraftsRepository` against a temp db and calls `insert` with a full `DraftInsert`). Add a case that asserts the new column round-trips:

```ts
it('persists generated_body_text from the insert', () => {
  const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
  db.prepare(
    `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('a1','imap','A','a@b.com')`,
  ).run();
  const threads = new ThreadsRepository(db);
  const threadId = threads.create('a1', 'subj', ['x@y.com'], 1000);
  const repo = new DraftsRepository(db);
  const id = repo.insert({
    threadId,
    accountId: 'a1',
    version: 1,
    inReplyToMessageId: null,
    to: [{ address: 'x@y.com' }],
    cc: [],
    subject: 'Re: subj',
    bodyText: 'original generated body',
    generatedBodyText: 'original generated body',
    rawIntent: null,
    polishDiff: null,
    systemPromptUsed: 'sys',
    modelUsed: 'm',
    tokensIn: 1,
    tokensOut: 1,
    latencyMs: 1,
    createdAt: 1000,
  });
  const row = repo.getById(id)!;
  db.close();
  expect(row.generated_body_text).toBe('original generated body');
});
```

(Ensure `ThreadsRepository` is imported in this test file; add the import if absent: `import { ThreadsRepository } from '../server/db/repositories/ThreadsRepository.js';`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @secretary/service test -- drafts-repository`
Expected: FAIL — TS error: `generatedBodyText` not in `DraftInsert` (and/or column not written).

- [ ] **Step 3: Add the field + write the column**

In `apps/service/server/db/repositories/DraftsRepository.ts`, add to `DraftInsert` (after `bodyText`):

```ts
  bodyText: string;
  generatedBodyText: string;
```

Update the `insert` SQL — add `generated_body_text` to the column list (after `body_text`) and one more `?`:

```ts
      .prepare(
        `INSERT INTO drafts
          (id, thread_id, account_id, version, in_reply_to_message_id, to_addresses, cc_addresses,
           subject, body_text, generated_body_text, raw_intent, polish_diff, system_prompt_used, model_used,
           tokens_in, tokens_out, latency_ms, status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending_review', ?)`,
      )
```

And add `input.generatedBodyText` to `.run(...)` immediately after `input.bodyText`:

```ts
        input.bodyText,
        input.generatedBodyText,
        input.rawIntent,
```

- [ ] **Step 4: Pass it from the Drafter**

In `apps/service/server/agent/Drafter.ts`, in the `this.drafts.insert({ ... })` call, add `generatedBodyText` right after `bodyText`:

```ts
        bodyText: body,
        generatedBodyText: body,
        rawIntent,
```

- [ ] **Step 4b: Update existing `DraftInsert` literals in tests**

Making `generatedBodyText` required breaks any other test that builds a `DraftInsert` literal. Find them and add `generatedBodyText` (mirror the `bodyText` value) to each:

```bash
rg -n "\.insert\(\{" apps/service/test/drafts-repository.test.ts apps/service/test/threads-routes.test.ts
```

In each `insert({ ... })` literal found (the existing case in `drafts-repository.test.ts` and the two in `threads-routes.test.ts`), add a `generatedBodyText` property next to `bodyText`, e.g.:

```ts
    bodyText: 'some body',
    generatedBodyText: 'some body',
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @secretary/service test -- drafts-repository drafter`
Expected: PASS (existing Drafter tests still green; the new repo case passes).

- [ ] **Step 6: Commit**

```bash
git add apps/service/server/db/repositories/DraftsRepository.ts apps/service/server/agent/Drafter.ts apps/service/test/drafts-repository.test.ts apps/service/test/threads-routes.test.ts
git commit -m "feat(6b): preserve agent-generated body in drafts.generated_body_text"
```

---

### Task 4: Heavy-edit logging on send

**Files:**
- Modify: `apps/service/server/api/drafts.ts` (import `divergenceRatio`, add `HEAVY_EDIT_THRESHOLD`, log after `markSent`)
- Test: `apps/service/test/drafts-routes.test.ts` (add heavy-edit cases)

- [ ] **Step 1: Write the failing test**

Add to `apps/service/test/drafts-routes.test.ts`. It builds a server with `makeTestServer`, registers an account (so the fake provider exists), seeds a thread + inbound message, generates a draft (the test drafter returns a known original body via `draftBody`), PATCHes a divergent body, sends, and inspects `action_log`. Use the existing imports in that file plus the repos; add a small helper:

```ts
import { ThreadsRepository } from '../server/db/repositories/ThreadsRepository.js';
import { MessagesRepository } from '../server/db/repositories/MessagesRepository.js';
import { ContactsRepository } from '../server/db/repositories/ContactsRepository.js';
import type { RawMessage } from '@secretary/shared-types';

function inbound(when: number): RawMessage {
  return {
    providerId: 'in1',
    references: [],
    messageIdHeader: '<in1@x>',
    from: { address: 'alice@x.com', name: 'Alice' },
    to: [{ address: 'me@b.com' }],
    cc: [],
    bcc: [],
    subject: 'Question',
    bodyText: 'Are you free Tuesday?',
    snippet: 'Are you free Tuesday?',
    direction: 'inbound',
    dateReceived: when,
    isRead: false,
    isStarred: false,
    folder: 'INBOX',
    labels: [],
    attachmentsMeta: [],
  };
}

async function seedDraft(opts: { draftBody: string }) {
  const t = await makeTestServer({ draftBody: opts.draftBody });
  const add = await t.app.inject({
    method: 'POST',
    url: '/api/v1/accounts/imap',
    headers: { authorization: `Bearer ${t.session}` },
    payload: {
      displayName: 'Me',
      emailAddress: 'me@b.com',
      imapHost: 'imap.example.com',
      imapPort: 993,
      useTls: true,
      smtpHost: 'smtp.example.com',
      smtpPort: 465,
      password: 'secret',
    },
  });
  const accountId = add.json().data.id as string;
  const threads = new ThreadsRepository(t.db);
  const messages = new MessagesRepository(t.db);
  const contacts = new ContactsRepository(t.db);
  const threadId = threads.create(accountId, 'question', ['alice@x.com'], 1000);
  contacts.recordSeen({ address: 'alice@x.com', name: 'Alice' }, 'inbound', 1000);
  messages.insert(accountId, threadId, inbound(1000));
  const draftRes = await t.app.inject({
    method: 'POST',
    url: '/api/v1/drafts',
    headers: { authorization: `Bearer ${t.session}` },
    payload: { threadId },
  });
  const draftId = draftRes.json().data.id as string;
  return { t, threadId, draftId };
}

function heavyEditCount(db: import('better-sqlite3-multiple-ciphers').Database): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM action_log WHERE action='draft_heavily_edited'")
      .get() as { n: number }
  ).n;
}

describe('send route — heavy-edit detection', () => {
  it('logs draft_heavily_edited (ids + ratio, no body) on a large rewrite', async () => {
    const { t, draftId } = await seedDraft({ draftBody: 'Generated original body here.' });
    await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/drafts/${draftId}`,
      headers: { authorization: `Bearer ${t.session}` },
      payload: { bodyText: 'Totally different rewritten content replacing everything now today.' },
    });
    const send = await t.app.inject({
      method: 'POST',
      url: `/api/v1/drafts/${draftId}/send`,
      headers: { authorization: `Bearer ${t.session}` },
      payload: {},
    });
    expect(send.statusCode).toBe(200);
    const row = t.db
      .prepare("SELECT details FROM action_log WHERE action='draft_heavily_edited'")
      .get() as { details: string } | undefined;
    await t.app.close();
    expect(row).toBeDefined();
    const details = JSON.parse(row!.details) as Record<string, unknown>;
    expect(typeof details.divergencePct).toBe('number');
    expect(JSON.stringify(details)).not.toContain('Totally different'); // no body text
  });

  it('does not log when the sent body barely changed', async () => {
    const { t, draftId } = await seedDraft({ draftBody: 'Generated original body here.' });
    await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/drafts/${draftId}`,
      headers: { authorization: `Bearer ${t.session}` },
      payload: { bodyText: 'Generated original body here too.' },
    });
    await t.app.inject({
      method: 'POST',
      url: `/api/v1/drafts/${draftId}/send`,
      headers: { authorization: `Bearer ${t.session}` },
      payload: {},
    });
    const n = heavyEditCount(t.db);
    await t.app.close();
    expect(n).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @secretary/service test -- drafts-routes`
Expected: FAIL — no `draft_heavily_edited` row is written.

- [ ] **Step 3: Implement the logging**

In `apps/service/server/api/drafts.ts`:

Add the import (with the other agent imports near the top):

```ts
import { divergenceRatio } from '../agent/draftDiff.js';
```

Add the threshold constant near the top of the file (after imports):

```ts
const HEAVY_EDIT_THRESHOLD = 0.3;
```

In `app.post('/drafts/:id/send', ...)`, immediately after the existing `drafts.markSent(...)` line and before `deps.stateMachine.onOutbound(...)`, add:

```ts
    if (draft.generated_body_text !== null) {
      const div = divergenceRatio(draft.generated_body_text, input.bodyText);
      if (div >= HEAVY_EDIT_THRESHOLD) {
        actions.append({
          actor: 'user',
          action: 'draft_heavily_edited',
          targetType: 'draft',
          targetId: id,
          details: {
            threadId: draft.thread_id,
            version: draft.version,
            divergencePct: Math.round(div * 100),
          },
        });
      }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @secretary/service test -- drafts-routes`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/service/server/api/drafts.ts apps/service/test/drafts-routes.test.ts
git commit -m "feat(6b): log draft_heavily_edited on send when divergence >= 0.30"
```

---

## Part B — Sent-mail mining (server)

### Task 5: `MessagesRepository.recentOutbound`

**Files:**
- Modify: `apps/service/server/db/repositories/MessagesRepository.ts`
- Test: `apps/service/test/messages-repository.test.ts` (add a case)

- [ ] **Step 1: Write the failing test**

Add to `apps/service/test/messages-repository.test.ts` (reuse its existing temp-db setup + a `RawMessage` builder; if the file lacks an outbound builder, add the helper shown). The case inserts inbound, outbound, and empty-body messages and asserts the filter + order + limit, plus exclusion of an `is_draft = 1` row:

```ts
function msg(overrides: Partial<RawMessage> & { providerId: string; direction: 'inbound' | 'outbound' }): RawMessage {
  return {
    references: [],
    messageIdHeader: `<${overrides.providerId}@x>`,
    from: { address: 'me@b.com' },
    to: [{ address: 'x@y.com' }],
    cc: [],
    bcc: [],
    subject: 's',
    bodyText: 'body',
    snippet: 'body',
    isRead: true,
    isStarred: false,
    folder: 'Sent',
    labels: [],
    attachmentsMeta: [],
    ...overrides,
  };
}

it('recentOutbound returns non-empty outbound messages, newest first, within limit', () => {
  const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
  db.prepare(
    `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('a1','imap','A','me@b.com')`,
  ).run();
  const threads = new ThreadsRepository(db);
  const messages = new MessagesRepository(db);
  const threadId = threads.create('a1', 's', ['x@y.com'], 1000);
  messages.insert('a1', threadId, msg({ providerId: 'in1', direction: 'inbound', dateReceived: 1000 }));
  messages.insert('a1', threadId, msg({ providerId: 'out-old', direction: 'outbound', dateSent: 2000 }));
  messages.insert('a1', threadId, msg({ providerId: 'out-new', direction: 'outbound', dateSent: 3000 }));
  messages.insert('a1', threadId, msg({ providerId: 'out-empty', direction: 'outbound', dateSent: 4000, bodyText: '   ' }));
  const out = messages.recentOutbound(10);
  // mark one outbound as a draft → excluded
  db.prepare("UPDATE messages SET is_draft = 1 WHERE provider_id = 'out-old'").run();
  const afterDraftFlag = messages.recentOutbound(10).map((m) => m.provider_id);
  db.close();
  expect(out.map((m) => m.provider_id)).toEqual(['out-new', 'out-old']); // newest first, empty excluded
  expect(afterDraftFlag).toEqual(['out-new']); // is_draft excluded
});
```

(Ensure `ThreadsRepository`, `RawMessage`, and the existing `MessagesRepository`/`openDatabase`/`InMemorySecretStore` imports are present in the file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @secretary/service test -- messages-repository`
Expected: FAIL — `recentOutbound is not a function`.

- [ ] **Step 3: Implement `recentOutbound`**

Add to `apps/service/server/db/repositories/MessagesRepository.ts` (after `latestInboundForThread`):

```ts
  /** The most recent genuinely-sent outbound messages (newest first), for style mining. */
  recentOutbound(limit: number): MessageRow[] {
    return this.db
      .prepare(
        `SELECT * FROM messages
         WHERE direction = 'outbound' AND (is_draft IS NULL OR is_draft = 0)
           AND body_text IS NOT NULL AND TRIM(body_text) != ''
         ORDER BY COALESCE(date_sent, date_received, 0) DESC
         LIMIT ?`,
      )
      .all(limit) as MessageRow[];
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @secretary/service test -- messages-repository`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/service/server/db/repositories/MessagesRepository.ts apps/service/test/messages-repository.test.ts
git commit -m "feat(6b): MessagesRepository.recentOutbound for style mining"
```

---

### Task 6: `StyleExamplesRepository` mining/review methods + approved-only sampling

**Files:**
- Modify: `apps/service/server/db/repositories/StyleExamplesRepository.ts`
- Test: `apps/service/test/style-examples-repository.test.ts` (add cases)

- [ ] **Step 1: Write the failing test**

Add to `apps/service/test/style-examples-repository.test.ts`:

```ts
describe('StyleExamplesRepository — mining/review', () => {
  it('insertPending writes a pending row; sample() ignores non-approved', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    const repo = new StyleExamplesRepository(db);
    const id = repo.insertPending({
      sourceMessageId: 'm1',
      contactCategory: 'vendor',
      contextSummary: 'ctx',
      replyText: 'reply',
      tags: '["concise"]',
    });
    const pendingSample = repo.sample('vendor', 3); // pending → not sampled
    repo.setStatus(id, 'approved');
    const approvedSample = repo.sample('vendor', 3).map((r) => r.id);
    db.close();
    expect(repo).toBeDefined();
    expect(pendingSample).toEqual([]);
    expect(approvedSample).toEqual([id]);
  });

  it('existsForMessage, listByStatus, and update behave', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    const repo = new StyleExamplesRepository(db);
    const id = repo.insertPending({
      sourceMessageId: 'm2',
      contactCategory: 'personal',
      contextSummary: 'ctx',
      replyText: 'reply',
      tags: '[]',
    });
    repo.update(id, { contextSummary: 'edited', tags: '["warm"]' });
    const pending = repo.listByStatus('pending');
    db.close();
    expect(repo.existsForMessage).toBeDefined();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.context_summary).toBe('edited');
    expect(pending[0]!.tags).toBe('["warm"]');
  });

  it('existsForMessage is true only for an inserted source message', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    const repo = new StyleExamplesRepository(db);
    repo.insertPending({
      sourceMessageId: 'm3',
      contactCategory: null,
      contextSummary: 'c',
      replyText: 'r',
      tags: '[]',
    });
    const yes = repo.existsForMessage('m3');
    const no = repo.existsForMessage('nope');
    db.close();
    expect(yes).toBe(true);
    expect(no).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @secretary/service test -- style-examples-repository`
Expected: FAIL — `insertPending is not a function` (and the approved-filter assertion).

- [ ] **Step 3: Implement the repository methods**

Replace the body of `apps/service/server/db/repositories/StyleExamplesRepository.ts` with:

```ts
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3-multiple-ciphers';
import type { ContactCategory } from '@secretary/shared-types';
import type { StyleExampleRow, StyleExampleStatus } from '../schema.js';

export interface StyleExampleInsert {
  sourceMessageId: string;
  contactCategory: string | null;
  contextSummary: string;
  replyText: string;
  tags: string;
}

export class StyleExamplesRepository {
  constructor(private readonly db: Database.Database) {}

  /** Up to `limit` APPROVED examples for the category; falls back to any approved when none match. */
  sample(category: ContactCategory, limit: number): StyleExampleRow[] {
    const matched = this.db
      .prepare("SELECT * FROM style_examples WHERE contact_category = ? AND status = 'approved' LIMIT ?")
      .all(category, limit) as StyleExampleRow[];
    if (matched.length >= limit) return matched;
    if (matched.length > 0) return matched;
    return this.db
      .prepare("SELECT * FROM style_examples WHERE status = 'approved' LIMIT ?")
      .all(limit) as StyleExampleRow[];
  }

  /** True if a style example already exists for this source message (idempotent mining). */
  existsForMessage(messageId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 AS x FROM style_examples WHERE source_message_id = ? LIMIT 1')
      .get(messageId) as { x: number } | undefined;
    return row !== undefined;
  }

  /** Inserts a mined example in the `pending` state; returns its id. */
  insertPending(input: StyleExampleInsert): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO style_examples
          (id, source_message_id, contact_category, context_summary, reply_text, tags, status)
         VALUES (?,?,?,?,?,?, 'pending')`,
      )
      .run(id, input.sourceMessageId, input.contactCategory, input.contextSummary, input.replyText, input.tags);
    return id;
  }

  listByStatus(status: StyleExampleStatus): StyleExampleRow[] {
    return this.db
      .prepare('SELECT * FROM style_examples WHERE status = ? ORDER BY rowid DESC')
      .all(status) as StyleExampleRow[];
  }

  listAll(): StyleExampleRow[] {
    return this.db.prepare('SELECT * FROM style_examples ORDER BY rowid DESC').all() as StyleExampleRow[];
  }

  getById(id: string): StyleExampleRow | undefined {
    return this.db.prepare('SELECT * FROM style_examples WHERE id = ?').get(id) as
      | StyleExampleRow
      | undefined;
  }

  setStatus(id: string, status: StyleExampleStatus): void {
    this.db.prepare('UPDATE style_examples SET status = ? WHERE id = ?').run(status, id);
  }

  update(id: string, fields: { contextSummary?: string; replyText?: string; tags?: string }): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (fields.contextSummary !== undefined) {
      sets.push('context_summary = ?');
      vals.push(fields.contextSummary);
    }
    if (fields.replyText !== undefined) {
      sets.push('reply_text = ?');
      vals.push(fields.replyText);
    }
    if (fields.tags !== undefined) {
      sets.push('tags = ?');
      vals.push(fields.tags);
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE style_examples SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @secretary/service test -- style-examples-repository draft-prompt`
Expected: PASS — the new cases plus the existing `sample` tests. (The existing `prefers category matches` test inserts rows without a `status`, so the `DEFAULT 'approved'` keeps them sampled — that test stays green.)

- [ ] **Step 5: Commit**

```bash
git add apps/service/server/db/repositories/StyleExamplesRepository.ts apps/service/test/style-examples-repository.test.ts
git commit -m "feat(6b): StyleExamplesRepository mining/review methods + approved-only sampling"
```

---

### Task 7: `MiningJob` progress tracker

**Files:**
- Create: `apps/service/server/agent/MiningJob.ts`
- Test: `apps/service/test/mining-job.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/service/test/mining-job.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { MiningJob } from '../server/agent/MiningJob.js';

describe('MiningJob', () => {
  it('tracks running/total/done across start, tick, finish', () => {
    const job = new MiningJob();
    expect(job.snapshot()).toEqual({ running: false, total: 0, done: 0 });
    job.start(3);
    expect(job.running).toBe(true);
    job.tick();
    job.tick();
    expect(job.snapshot()).toEqual({ running: true, total: 3, done: 2 });
    job.finish();
    expect(job.snapshot()).toEqual({ running: false, total: 3, done: 2 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @secretary/service test -- mining-job`
Expected: FAIL — cannot find module `MiningJob.js`.

- [ ] **Step 3: Implement `MiningJob`**

Create `apps/service/server/agent/MiningJob.ts`:

```ts
/** In-process progress tracker for the one-time sent-mail mining run. */
export interface MiningSnapshot {
  running: boolean;
  total: number;
  done: number;
}

export class MiningJob {
  private _running = false;
  private _total = 0;
  private _done = 0;

  get running(): boolean {
    return this._running;
  }

  start(total: number): void {
    this._running = true;
    this._total = total;
    this._done = 0;
  }

  tick(): void {
    this._done += 1;
  }

  finish(): void {
    this._running = false;
  }

  snapshot(): MiningSnapshot {
    return { running: this._running, total: this._total, done: this._done };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @secretary/service test -- mining-job`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/service/server/agent/MiningJob.ts apps/service/test/mining-job.test.ts
git commit -m "feat(6b): MiningJob progress tracker"
```

---

### Task 8: `PromptAssembler.buildMiningPrompt`

**Files:**
- Modify: `apps/service/server/agent/PromptAssembler.ts`
- Test: `apps/service/test/prompt-assembler.test.ts` (add a case)

- [ ] **Step 1: Write the failing test**

Add to `apps/service/test/prompt-assembler.test.ts` (it already constructs a `PromptAssembler` against a temp db — reuse that setup; the prompt method doesn't touch the DB, so a minimally-constructed assembler works):

```ts
it('buildMiningPrompt asks for JSON and includes reply + inbound context', () => {
  const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
  const prompts = new PromptAssembler(
    new MessagesRepository(db),
    new ThreadsRepository(db),
    new ContactsRepository(db),
    new SettingsRepository(db),
    new StyleExamplesRepository(db),
  );
  const out = prompts.buildMiningPrompt({
    subject: 'Re: Meeting',
    sentReply: 'Tuesday at 2 works for me.',
    inboundContext: 'Are you free Tuesday?',
  });
  db.close();
  expect(out.system).toContain('JSON');
  expect(out.system).toContain('context_summary');
  expect(out.prompt).toContain('Tuesday at 2 works for me.');
  expect(out.prompt).toContain('Are you free Tuesday?');
});
```

(Add any missing imports — `PromptAssembler`, the repos, `openDatabase`, `InMemorySecretStore` — matching the file's existing style.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @secretary/service test -- prompt-assembler`
Expected: FAIL — `buildMiningPrompt is not a function`.

- [ ] **Step 3: Implement `buildMiningPrompt`**

Add a public method to the `PromptAssembler` class in `apps/service/server/agent/PromptAssembler.ts` (it uses the existing module-level `truncate`, `SNIPPET_MAX`, `BODY_MAX`):

```ts
  buildMiningPrompt(input: {
    subject: string | null;
    sentReply: string;
    inboundContext: string | null;
  }): { system: string; prompt: string } {
    const system = [
      'You analyze one email reply the user sent, to capture their writing style.',
      'Output ONLY a JSON object: {"context_summary": string, "tags": string[]}.',
      'context_summary: 1-2 sentences describing the situation being responded to.',
      'tags: short style descriptors (e.g. "warm", "concise", "no-signoff").',
      'Do not output any prose outside the JSON.',
    ].join('\n');

    const lines: string[] = [];
    if (input.subject) lines.push(`Subject: ${truncate(input.subject, SNIPPET_MAX)}`);
    if (input.inboundContext) {
      lines.push('## They wrote (context)');
      lines.push(truncate(input.inboundContext, SNIPPET_MAX));
      lines.push('');
    }
    lines.push('## The user replied');
    lines.push(truncate(input.sentReply, BODY_MAX));
    return { system, prompt: lines.join('\n') };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @secretary/service test -- prompt-assembler`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/service/server/agent/PromptAssembler.ts apps/service/test/prompt-assembler.test.ts
git commit -m "feat(6b): PromptAssembler.buildMiningPrompt"
```

---

### Task 9: `SentMailMiner` + `mining:progress` event

**Files:**
- Modify: `apps/service/server/eventBus.ts` (add `mining:progress` to the union)
- Create: `apps/service/server/agent/SentMailMiner.ts`
- Test: `apps/service/test/sent-mail-miner.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/service/test/sent-mail-miner.test.ts` (mirrors `drafter.test.ts`: seed a thread with an inbound + an outbound reply, run `mine`, assert a pending row):

```ts
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
import { MiningJob } from '../server/agent/MiningJob.js';
import { SentMailMiner } from '../server/agent/SentMailMiner.js';
import { EventBus } from '../server/eventBus.js';
import { FakeGateway, ThrowingGateway } from './helpers/fakeGateway.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secretary-miner-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const NOOP_LOG = { info() {}, warn() {} };

function raw(p: { providerId: string; direction: 'inbound' | 'outbound'; body: string; when: number }): RawMessage {
  return {
    providerId: p.providerId,
    references: [],
    messageIdHeader: `<${p.providerId}@x>`,
    from: p.direction === 'inbound' ? { address: 'alice@x.com', name: 'Alice' } : { address: 'me@b.com' },
    to: p.direction === 'inbound' ? [{ address: 'me@b.com' }] : [{ address: 'alice@x.com' }],
    cc: [],
    bcc: [],
    subject: 'Re: Meeting',
    bodyText: p.body,
    snippet: p.body.slice(0, 200),
    direction: p.direction,
    ...(p.direction === 'inbound' ? { dateReceived: p.when } : { dateSent: p.when }),
    isRead: true,
    isStarred: false,
    folder: 'Sent',
    labels: [],
    attachmentsMeta: [],
  };
}

function setup(gateway: FakeGateway | ThrowingGateway | null) {
  const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
  db.prepare(
    `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('a1','imap','A','me@b.com')`,
  ).run();
  const threads = new ThreadsRepository(db);
  const messages = new MessagesRepository(db);
  const contacts = new ContactsRepository(db);
  const styleExamples = new StyleExamplesRepository(db);
  const threadId = threads.create('a1', 'meeting', ['alice@x.com'], 1000);
  contacts.recordSeen({ address: 'alice@x.com', name: 'Alice' }, 'inbound', 1000);
  // set the contact's category so resolveCategory returns it
  db.prepare("UPDATE contacts SET category = 'client_established' WHERE email_address = 'alice@x.com'").run();
  messages.insert('a1', threadId, raw({ providerId: 'in1', direction: 'inbound', body: 'Are you free Tuesday?', when: 1000 }));
  const outId = messages.insert('a1', threadId, raw({ providerId: 'out1', direction: 'outbound', body: 'Tuesday at 2 works for me.', when: 2000 }))!;
  const job = new MiningJob();
  job.start(1);
  const prompts = new PromptAssembler(messages, threads, contacts, new SettingsRepository(db), styleExamples);
  const miner = new SentMailMiner(prompts, gateway, messages, contacts, styleExamples, job, new EventBus(), NOOP_LOG, new SettingsRepository(db));
  return { db, miner, styleExamples, outId, job };
}

describe('SentMailMiner.mine', () => {
  it('writes a pending style example with parsed fields + resolved category', async () => {
    const { db, miner, styleExamples, outId, job } = setup(
      new FakeGateway(['{"context_summary":"Replying to a meeting request.","tags":["concise","warm"]}']),
    );
    await miner.mine(outId);
    const rows = styleExamples.listByStatus('pending');
    const snap = job.snapshot();
    db.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.context_summary).toBe('Replying to a meeting request.');
    expect(rows[0]!.contact_category).toBe('client_established');
    expect(rows[0]!.reply_text).toBe('Tuesday at 2 works for me.');
    expect(JSON.parse(rows[0]!.tags!)).toEqual(['concise', 'warm']);
    expect(snap.done).toBe(1); // tick fired
  });

  it('is idempotent: a second mine of the same message inserts nothing', async () => {
    const { db, miner, styleExamples, outId } = setup(
      new FakeGateway(['{"context_summary":"c","tags":[]}', '{"context_summary":"c2","tags":[]}']),
    );
    await miner.mine(outId);
    await miner.mine(outId);
    const rows = styleExamples.listAll();
    db.close();
    expect(rows).toHaveLength(1);
  });

  it('writes nothing on bad JSON but still ticks (never throws)', async () => {
    const { db, miner, styleExamples, outId, job } = setup(new FakeGateway(['not json at all']));
    await miner.mine(outId);
    const rows = styleExamples.listAll();
    const snap = job.snapshot();
    db.close();
    expect(rows).toHaveLength(0);
    expect(snap.done).toBe(1);
  });

  it('writes nothing on a gateway throw but still ticks', async () => {
    const { db, miner, styleExamples, outId, job } = setup(new ThrowingGateway());
    await miner.mine(outId);
    const rows = styleExamples.listAll();
    const snap = job.snapshot();
    db.close();
    expect(rows).toHaveLength(0);
    expect(snap.done).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @secretary/service test -- sent-mail-miner`
Expected: FAIL — cannot find module `SentMailMiner.js`.

- [ ] **Step 3: Add the event type**

In `apps/service/server/eventBus.ts`, add a member to the `ServerEvent` union:

```ts
export type ServerEvent =
  | { type: 'thread:updated'; payload: unknown }
  | { type: 'draft:ready'; payload: unknown }
  | { type: 'account:status'; payload: unknown }
  | { type: 'sync:progress'; payload: unknown }
  | { type: 'mining:progress'; payload: { done: number; total: number } };
```

- [ ] **Step 4: Implement `SentMailMiner`**

Create `apps/service/server/agent/SentMailMiner.ts`:

```ts
import { z } from 'zod';
import type { ContactsRepository } from '../db/repositories/ContactsRepository.js';
import type { MessagesRepository } from '../db/repositories/MessagesRepository.js';
import type { SettingsRepository } from '../db/repositories/SettingsRepository.js';
import type { StyleExamplesRepository } from '../db/repositories/StyleExamplesRepository.js';
import type { GatewayClient } from '../llm/GatewayClient.js';
import type { EventBus } from '../eventBus.js';
import type { MessageRow } from '../db/schema.js';
import type { MiniLogger } from './Classifier.js';
import type { MiningJob } from './MiningJob.js';
import type { PromptAssembler } from './PromptAssembler.js';

const DEFAULT_MODEL = 'qwen2.5:14b-instruct-q5_K_M';
const MINING_TEMPERATURE = 0.2;
const MINING_MAX_TOKENS = 200;

const miningResultSchema = z.object({
  context_summary: z.string(),
  tags: z.array(z.string()),
});

/** Extracts the first {...} JSON object from a (possibly chatty) model response. */
function extractJson(raw: string): unknown {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return undefined;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function firstRecipient(json: string | null): string | null {
  if (!json) return null;
  try {
    const arr = JSON.parse(json) as Array<{ address?: string }>;
    return arr[0]?.address ?? null;
  } catch {
    return null;
  }
}

/** Mines one sent outbound message into a pending style example. Never throws (queue-safe). */
export class SentMailMiner {
  constructor(
    private readonly prompts: PromptAssembler,
    private readonly gateway: GatewayClient | null,
    private readonly messages: MessagesRepository,
    private readonly contacts: ContactsRepository,
    private readonly styleExamples: StyleExamplesRepository,
    private readonly miningJob: MiningJob,
    private readonly eventBus: EventBus,
    private readonly log: MiniLogger,
    private readonly settings: SettingsRepository,
  ) {}

  async mine(messageId: string): Promise<void> {
    try {
      if (!this.gateway) return;
      const msg = this.messages.getById(messageId);
      if (
        !msg ||
        msg.direction !== 'outbound' ||
        !msg.body_text ||
        msg.body_text.trim() === '' ||
        msg.is_draft === 1
      ) {
        return;
      }
      if (this.styleExamples.existsForMessage(messageId)) return;

      const inbound = this.messages.latestInboundForThread(msg.thread_id);
      const category = this.resolveCategory(msg, inbound);
      const inboundContext = inbound ? (inbound.body_text ?? inbound.snippet ?? null) : null;

      const { system, prompt } = this.prompts.buildMiningPrompt({
        subject: msg.subject,
        sentReply: msg.body_text,
        inboundContext,
      });
      const model = this.settings.get<string>('llm.model') ?? DEFAULT_MODEL;
      const res = await this.gateway.complete({
        model,
        system,
        prompt,
        temperature: MINING_TEMPERATURE,
        max_tokens: MINING_MAX_TOKENS,
      });
      const parsed = miningResultSchema.safeParse(extractJson(res.response));
      if (!parsed.success) {
        this.log.warn({ messageId }, 'mining: could not parse extraction; skipping');
        return;
      }
      this.styleExamples.insertPending({
        sourceMessageId: messageId,
        contactCategory: category,
        contextSummary: parsed.data.context_summary,
        replyText: msg.body_text.trim(),
        tags: JSON.stringify(parsed.data.tags),
      });
    } catch (err) {
      this.log.warn(
        { messageId, err: err instanceof Error ? err.message : 'unknown' },
        'mining error',
      );
    } finally {
      this.miningJob.tick();
      const { done, total } = this.miningJob.snapshot();
      this.eventBus.emit({ type: 'mining:progress', payload: { done, total } });
    }
  }

  private resolveCategory(msg: MessageRow, inbound: MessageRow | undefined): string {
    if (inbound) return this.contacts.findByEmail(inbound.from_address)?.category ?? 'unknown';
    const addr = firstRecipient(msg.to_addresses);
    if (addr) return this.contacts.findByEmail(addr)?.category ?? 'unknown';
    return 'unknown';
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @secretary/service test -- sent-mail-miner`
Expected: PASS (all four cases).

- [ ] **Step 6: Commit**

```bash
git add apps/service/server/eventBus.ts apps/service/server/agent/SentMailMiner.ts apps/service/test/sent-mail-miner.test.ts
git commit -m "feat(6b): SentMailMiner + mining:progress event"
```

---

### Task 10: Mining API routes + wiring + test-server fake

**Files:**
- Create: `apps/service/server/api/style.ts` (`registerStyleRoutes` — mining routes here; review routes added in Task 11)
- Modify: `apps/service/server/server.ts` (`ServerDeps.mining`, register the routes)
- Modify: `apps/service/server/index.ts` (build `miner`, `miningQueue`, `miningJob`; pass `mining`)
- Modify: `apps/service/test/helpers/testServer.ts` (provide a `mining` fake; expose it)
- Test: `apps/service/test/style-routes.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/service/test/style-routes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { makeTestServer } from './helpers/testServer.js';
import { ThreadsRepository } from '../server/db/repositories/ThreadsRepository.js';
import { MessagesRepository } from '../server/db/repositories/MessagesRepository.js';
import type { RawMessage } from '@secretary/shared-types';

function outbound(providerId: string, when: number): RawMessage {
  return {
    providerId,
    references: [],
    messageIdHeader: `<${providerId}@x>`,
    from: { address: 'me@b.com' },
    to: [{ address: 'alice@x.com' }],
    cc: [],
    bcc: [],
    subject: 'Re: Hi',
    bodyText: 'A real sent reply body.',
    snippet: 'A real sent reply body.',
    direction: 'outbound',
    dateSent: when,
    isRead: true,
    isStarred: false,
    folder: 'Sent',
    labels: [],
    attachmentsMeta: [],
  };
}

describe('style routes — mining', () => {
  it('POST /style/mine enqueues outbound candidates and reports counts', async () => {
    const t = await makeTestServer();
    const threads = new ThreadsRepository(t.db);
    const messages = new MessagesRepository(t.db);
    t.db
      .prepare(`INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('a1','imap','A','me@b.com')`)
      .run();
    const threadId = threads.create('a1', 'hi', ['alice@x.com'], 1000);
    messages.insert('a1', threadId, outbound('o1', 2000));
    messages.insert('a1', threadId, outbound('o2', 3000));

    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/style/mine',
      headers: { authorization: `Bearer ${t.session}` },
      payload: {},
    });
    await t.app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().data.enqueued).toBe(2);
    expect(res.json().data.alreadyMined).toBe(0);
    expect(t.mining.enqueued).toHaveLength(2);
  });

  it('GET /style/mining-status returns the job snapshot', async () => {
    const t = await makeTestServer();
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/v1/style/mining-status',
      headers: { authorization: `Bearer ${t.session}` },
    });
    await t.app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ running: false, total: 0, done: 0 });
  });

  it('POST /style/mine returns 409 when a job is already running', async () => {
    const t = await makeTestServer();
    t.mining.job.start(5); // simulate an in-flight run
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/style/mine',
      headers: { authorization: `Bearer ${t.session}` },
      payload: {},
    });
    await t.app.close();
    expect(res.statusCode).toBe(409);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @secretary/service test -- style-routes`
Expected: FAIL — `t.mining` undefined / route 404 (routes + dep don't exist yet).

- [ ] **Step 3: Create the route module (mining routes)**

Create `apps/service/server/api/style.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3-multiple-ciphers';
import { SecretaryError, UpstreamError, ValidationError } from '@secretary/shared-types';
import { MessagesRepository } from '../db/repositories/MessagesRepository.js';
import { StyleExamplesRepository } from '../db/repositories/StyleExamplesRepository.js';
import type { MiningJob } from '../agent/MiningJob.js';

const MINE_LIMIT = 200;

export interface MiningDeps {
  queue: { enqueue(id: string): void; onIdle(): Promise<void> };
  job: MiningJob;
  gatewayReady: boolean;
}

export interface StyleRouteDeps {
  db: Database.Database;
  mining: MiningDeps;
}

export function registerStyleRoutes(app: FastifyInstance, deps: StyleRouteDeps): void {
  const messages = new MessagesRepository(deps.db);
  const styleExamples = new StyleExamplesRepository(deps.db);

  app.post('/style/mine', async () => {
    if (!deps.mining.gatewayReady) {
      throw new UpstreamError('gateway_unavailable', 'LLM gateway is not configured', 503);
    }
    if (deps.mining.job.running) {
      throw new SecretaryError('mining_in_progress', 'Mining is already in progress', 409);
    }
    const candidates = messages.recentOutbound(MINE_LIMIT);
    const fresh = candidates.filter((m) => !styleExamples.existsForMessage(m.id));
    const alreadyMined = candidates.length - fresh.length;
    if (fresh.length > 0) {
      deps.mining.job.start(fresh.length);
      for (const m of fresh) deps.mining.queue.enqueue(m.id);
      void deps.mining.queue.onIdle().then(() => deps.mining.job.finish());
    }
    return { data: { enqueued: fresh.length, alreadyMined } };
  });

  app.get('/style/mining-status', async () => {
    return { data: deps.mining.job.snapshot() };
  });
}
```

`SecretaryError` is the directly-constructable base class (`constructor(code, message, status = 500)`), and the server error handler maps `err instanceof SecretaryError` → `reply.code(err.status)`. So `throw new SecretaryError('mining_in_progress', '…', 409)` produces the `409` the test expects. (`ValidationError` is 400 and `UpstreamError` defaults to 502 — that's why the conflict uses `SecretaryError` directly and the no-gateway case uses `UpstreamError(..., 503)`.)

- [ ] **Step 4: Add `mining` to `ServerDeps` and register the routes**

In `apps/service/server/server.ts`:

Add the import near the other route imports:

```ts
import { registerStyleRoutes, type MiningDeps } from './api/style.js';
```

Add to the `ServerDeps` interface (after `push?`):

```ts
  /** Sent-mail mining lane + progress + whether the gateway is configured. */
  mining: MiningDeps;
```

Register inside the `{ prefix: '/api/v1' }` block, after `registerDraftsRoutes(api, deps);`:

```ts
      registerStyleRoutes(api, deps);
```

- [ ] **Step 5: Wire it in `index.ts`**

In `apps/service/server/index.ts`, add imports near the agent imports:

```ts
import { SentMailMiner } from './agent/SentMailMiner.js';
import { MiningJob } from './agent/MiningJob.js';
```

After the `classificationQueue` is created (around line 136), add the mining lane (it reuses the already-built `promptAssembler`, `messagesRepo`, `contactsRepo`, `styleExamplesRepo`, `settingsRepo`, `eventBus`, `log`, `gateway`):

```ts
  const miningJob = new MiningJob();
  const miner = new SentMailMiner(
    promptAssembler,
    gateway,
    messagesRepo,
    contactsRepo,
    styleExamplesRepo,
    miningJob,
    eventBus,
    log,
    settingsRepo,
  );
  const miningQueue = new SequentialQueue((id) => miner.mine(id));
```

Pass `mining` into the `buildServer({ ... })` call (alongside `drafter`, `push`):

```ts
    mining: { queue: miningQueue, job: miningJob, gatewayReady: gateway !== null },
```

(If the local variable names differ — e.g. the logger is `log` and the settings repo `settingsRepo` — use whatever names this file already defines; confirm by reading lines 60–137.)

- [ ] **Step 6: Provide a `mining` fake in the test server**

In `apps/service/test/helpers/testServer.ts`:

Add to the `TestServer` interface:

```ts
  mining: { enqueued: string[]; job: MiningJob; queue: { enqueue(id: string): void; onIdle(): Promise<void> } };
```

Add the import:

```ts
import { MiningJob } from '../../server/agent/MiningJob.js';
```

Build the fake before `buildServer(...)`:

```ts
  const miningEnqueued: string[] = [];
  const miningJob = new MiningJob();
  const mining = {
    enqueued: miningEnqueued,
    job: miningJob,
    queue: {
      enqueue(id: string) {
        miningEnqueued.push(id);
      },
      onIdle: () => Promise.resolve(),
    },
  };
```

Pass it into `buildServer({ ... })`:

```ts
    mining,
```

And return it in the result object:

```ts
    mining,
```

(Check for other direct `buildServer(...)` callers: `grep -rl "buildServer(" apps/service/test`. Any caller other than `testServer.ts` must also pass a `mining` object — add the same fake.)

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm --filter @secretary/service test -- style-routes`
Then the full suite to catch wiring regressions: `pnpm --filter @secretary/service test`
Expected: PASS (style-routes green; all existing route/server tests still green).

- [ ] **Step 8: Commit**

```bash
git add apps/service/server/api/style.ts apps/service/server/server.ts apps/service/server/index.ts apps/service/test/helpers/testServer.ts apps/service/test/style-routes.test.ts
git commit -m "feat(6b): mining API (POST /style/mine, GET /style/mining-status) + wiring"
```

---

## Part C — Review (server API + shared types + PWA)

### Task 11: Review API + `StyleExampleView` shared type

**Files:**
- Modify: `packages/shared-types/src/domain.ts` (`StyleExampleStatus`, `StyleExampleView`)
- Modify: `apps/service/server/api/views.ts` (`styleExampleView` mapper)
- Modify: `apps/service/server/api/style.ts` (`GET /style/examples`, `PATCH /style/examples/:id`)
- Test: `apps/service/test/style-routes.test.ts` (add review cases)

- [ ] **Step 1: Add the shared type + rebuild the package**

In `packages/shared-types/src/domain.ts`, add (near `ContactView`/`DraftView`):

```ts
export type StyleExampleStatus = 'pending' | 'approved' | 'rejected';

export interface StyleExampleView {
  id: string;
  sourceMessageId: string | null;
  category: ContactCategory | null;
  contextSummary: string;
  replyText: string;
  tags: string[];
  status: StyleExampleStatus;
}
```

(`ContactCategory` is already defined/exported in this file — reuse it.)

Rebuild so the service + PWA pick up the new types:

```bash
pnpm --filter @secretary/shared-types build
```

- [ ] **Step 2: Write the failing test**

Add to `apps/service/test/style-routes.test.ts`:

```ts
import { StyleExamplesRepository } from '../server/db/repositories/StyleExamplesRepository.js';

describe('style routes — review', () => {
  it('GET /style/examples?status=pending returns mapped views; PATCH approves + edits', async () => {
    const t = await makeTestServer();
    const repo = new StyleExamplesRepository(t.db);
    const id = repo.insertPending({
      sourceMessageId: 'm1',
      contactCategory: 'vendor',
      contextSummary: 'ctx',
      replyText: 'reply',
      tags: '["concise"]',
    });

    const list = await t.app.inject({
      method: 'GET',
      url: '/api/v1/style/examples?status=pending',
      headers: { authorization: `Bearer ${t.session}` },
    });
    expect(list.statusCode).toBe(200);
    const views = list.json().data as Array<Record<string, unknown>>;
    expect(views).toHaveLength(1);
    expect(views[0]!.tags).toEqual(['concise']);
    expect(views[0]!.status).toBe('pending');

    const patch = await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/style/examples/${id}`,
      headers: { authorization: `Bearer ${t.session}` },
      payload: { status: 'approved', contextSummary: 'edited ctx', tags: ['warm', 'brief'] },
    });
    await t.app.close();
    expect(patch.statusCode).toBe(200);
    const view = patch.json().data as Record<string, unknown>;
    expect(view.status).toBe('approved');
    expect(view.contextSummary).toBe('edited ctx');
    expect(view.tags).toEqual(['warm', 'brief']);
  });

  it('PATCH /style/examples/:id 404s for unknown id', async () => {
    const t = await makeTestServer();
    const res = await t.app.inject({
      method: 'PATCH',
      url: '/api/v1/style/examples/nope',
      headers: { authorization: `Bearer ${t.session}` },
      payload: { status: 'rejected' },
    });
    await t.app.close();
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @secretary/service test -- style-routes`
Expected: FAIL — `GET /style/examples` 404 (route not added).

- [ ] **Step 4: Add the view mapper**

In `apps/service/server/api/views.ts`, add (and extend the imports from `@secretary/shared-types` to include `ContactCategory`, `StyleExampleView`, and from `../db/schema.js` `StyleExampleRow`):

```ts
const CONTACT_CATEGORIES: ReadonlySet<string> = new Set([
  'client_established',
  'client_new',
  'screening',
  'personal',
  'vendor',
  'noise',
  'unknown',
]);

export function styleExampleView(row: StyleExampleRow): StyleExampleView {
  let tags: string[] = [];
  if (row.tags) {
    try {
      const parsed = JSON.parse(row.tags) as unknown;
      if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === 'string');
    } catch {
      tags = [];
    }
  }
  const category =
    row.contact_category && CONTACT_CATEGORIES.has(row.contact_category)
      ? (row.contact_category as ContactCategory)
      : null;
  return {
    id: row.id,
    sourceMessageId: row.source_message_id,
    category,
    contextSummary: row.context_summary ?? '',
    replyText: row.reply_text ?? '',
    tags,
    status: row.status,
  };
}
```

- [ ] **Step 5: Add the review routes**

In `apps/service/server/api/style.ts`, add the imports:

```ts
import { z } from 'zod';
import { NotFoundError } from '@secretary/shared-types';
import { styleExampleView } from './views.js';
import type { StyleExampleStatus } from '../db/schema.js';
```

Add a schema near the top of the file:

```ts
const patchSchema = z
  .object({
    status: z.enum(['pending', 'approved', 'rejected']).optional(),
    contextSummary: z.string().optional(),
    replyText: z.string().optional(),
    tags: z.array(z.string()).optional(),
  })
  .strict();
```

Add inside `registerStyleRoutes` (after the mining routes):

```ts
  app.get('/style/examples', async (req) => {
    const status = (req.query as { status?: string }).status;
    const rows =
      status === 'pending' || status === 'approved' || status === 'rejected'
        ? styleExamples.listByStatus(status as StyleExampleStatus)
        : styleExamples.listAll();
    return { data: rows.map(styleExampleView) };
  });

  app.patch('/style/examples/:id', async (req) => {
    const { id } = req.params as { id: string };
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid style-example patch');
    if (!styleExamples.getById(id)) throw new NotFoundError('Style example not found');
    const { status, contextSummary, replyText, tags } = parsed.data;
    const fields: { contextSummary?: string; replyText?: string; tags?: string } = {};
    if (contextSummary !== undefined) fields.contextSummary = contextSummary;
    if (replyText !== undefined) fields.replyText = replyText;
    if (tags !== undefined) fields.tags = JSON.stringify(tags);
    if (Object.keys(fields).length > 0) styleExamples.update(id, fields);
    if (status !== undefined) styleExamples.setStatus(id, status);
    return { data: styleExampleView(styleExamples.getById(id)!) };
  });
```

(`ValidationError` is already imported in `style.ts` from Task 10.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @secretary/service test -- style-routes`
Expected: PASS (mining + review cases).

- [ ] **Step 7: Commit**

```bash
git add packages/shared-types/src/domain.ts apps/service/server/api/views.ts apps/service/server/api/style.ts apps/service/test/style-routes.test.ts
git commit -m "feat(6b): review API (GET/PATCH /style/examples) + StyleExampleView"
```

---

### Task 12: PWA hooks + `mining:progress` SSE handling

**Files:**
- Modify: `apps/service/pwa/src/api/hooks.ts` (4 hooks)
- Modify: `apps/service/pwa/src/sse/events.ts` (type union + `createEventStream` types array)
- Modify: `apps/service/pwa/src/sse/useServerEvents.ts` (handle `mining:progress`)
- Test: `apps/service/pwa/src/sse/events.test.ts` (add a case)

- [ ] **Step 1: Write the failing test**

Add to `apps/service/pwa/src/sse/events.test.ts`:

```ts
it('mining:progress yields no query invalidations (handled via setQueryData)', () => {
  expect(eventToInvalidations({ type: 'mining:progress', payload: { done: 1, total: 3 } })).toEqual(
    [],
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @secretary/pwa test -- events`
Expected: FAIL — TS error: `'mining:progress'` not assignable to `ServerEvent['type']`.

- [ ] **Step 3: Extend the PWA event type + stream**

In `apps/service/pwa/src/sse/events.ts`:

Update the `ServerEvent` type:

```ts
export interface ServerEvent {
  type: 'thread:updated' | 'draft:ready' | 'account:status' | 'sync:progress' | 'mining:progress';
  payload: { threadId?: string; draftId?: string; accountId?: string } & Record<string, unknown>;
}
```

Add `'mining:progress'` to the `types` array in `createEventStream`:

```ts
  const types: ServerEvent['type'][] = [
    'thread:updated',
    'draft:ready',
    'account:status',
    'sync:progress',
    'mining:progress',
  ];
```

(`eventToInvalidations` already returns `[]` via its `default` case — no change needed there; the test passes once the type accepts `'mining:progress'`.)

- [ ] **Step 4: Handle progress in `useServerEvents`**

Replace the body of the `createEventStream(...)` callback in `apps/service/pwa/src/sse/useServerEvents.ts`:

```ts
    return createEventStream(token, (event) => {
      markSynced();
      if (event.type === 'mining:progress') {
        const done = Number(event.payload.done ?? 0);
        const total = Number(event.payload.total ?? 0);
        qc.setQueryData(['mining-status'], { running: total > 0 && done < total, total, done });
        if (total > 0 && done >= total) void qc.invalidateQueries({ queryKey: ['style-examples'] });
        return;
      }
      for (const key of eventToInvalidations(event)) void qc.invalidateQueries({ queryKey: key });
    });
```

- [ ] **Step 5: Add the hooks**

Append to `apps/service/pwa/src/api/hooks.ts` (extend the `@secretary/shared-types` import to include `StyleExampleView`):

```ts
export interface MiningStatus {
  running: boolean;
  total: number;
  done: number;
}

export function useStyleExamples(
  status: 'pending' | 'approved' | 'rejected' = 'pending',
): UseQueryResult<StyleExampleView[]> {
  return useQuery({
    queryKey: ['style-examples', status],
    queryFn: () => apiFetch<StyleExampleView[]>(`/style/examples?status=${status}`),
  });
}

export function useMiningStatus(): UseQueryResult<MiningStatus> {
  return useQuery({
    queryKey: ['mining-status'],
    queryFn: () => apiFetch<MiningStatus>('/style/mining-status'),
  });
}

export function useMineSentMail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ enqueued: number; alreadyMined: number }>('/style/mine', {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['mining-status'] });
    },
  });
}

export function usePatchStyleExample() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      id: string;
      status?: 'pending' | 'approved' | 'rejected';
      contextSummary?: string;
      replyText?: string;
      tags?: string[];
    }) => {
      const { id, ...fields } = vars;
      return apiFetch<StyleExampleView>(`/style/examples/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(fields),
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['style-examples'] });
    },
  });
}
```

- [ ] **Step 6: Run tests + typecheck**

Run: `pnpm --filter @secretary/pwa test -- events`
Then: `pnpm --filter @secretary/pwa build` (typecheck the hooks/SSE against the rebuilt shared-types)
Expected: tests PASS; build succeeds.

- [ ] **Step 7: Commit**

```bash
git add apps/service/pwa/src/api/hooks.ts apps/service/pwa/src/sse/events.ts apps/service/pwa/src/sse/useServerEvents.ts apps/service/pwa/src/sse/events.test.ts
git commit -m "feat(6b): PWA hooks + mining:progress SSE handling"
```

---

### Task 13: PWA review screen + route + Settings entry

**Files:**
- Create: `apps/service/pwa/src/routes/StyleExamples.tsx`
- Modify: `apps/service/pwa/src/App.tsx` (route)
- Modify: `apps/service/pwa/src/routes/Settings.tsx` (entry link)
- Verification: build + manual runbook (UI is manually verified per BRIEF §18)

- [ ] **Step 1: Create the screen**

Create `apps/service/pwa/src/routes/StyleExamples.tsx`:

```tsx
import { useState } from 'react';
import type { StyleExampleView } from '@secretary/shared-types';
import {
  useStyleExamples,
  useMiningStatus,
  useMineSentMail,
  usePatchStyleExample,
} from '../api/hooks.js';

type Filter = 'pending' | 'approved' | 'rejected';
const FILTERS: Filter[] = ['pending', 'approved', 'rejected'];

export function StyleExamples(): JSX.Element {
  const [filter, setFilter] = useState<Filter>('pending');
  const q = useStyleExamples(filter);
  const status = useMiningStatus();
  const mine = useMineSentMail();

  const running = status.data?.running ?? false;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Mined style examples</h1>
        <button
          type="button"
          className="rounded bg-slate-800 px-3 py-1.5 text-sm text-white disabled:opacity-50"
          disabled={running || mine.isPending}
          onClick={() => mine.mutate()}
        >
          Mine sent mail
        </button>
      </div>

      {running && status.data ? (
        <p className="text-sm text-slate-500">
          Mining {status.data.done} / {status.data.total}…
        </p>
      ) : null}
      {mine.data ? (
        <p className="text-sm text-slate-500">
          Enqueued {mine.data.enqueued} (already mined {mine.data.alreadyMined}).
        </p>
      ) : null}

      <div className="flex gap-2 text-sm">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            className={`rounded px-2 py-1 ${filter === f ? 'bg-slate-200 font-medium' : 'text-slate-500'}`}
            onClick={() => setFilter(f)}
          >
            {f[0]!.toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {q.isLoading ? <p>Loading…</p> : null}
      {q.error ? <p className="text-red-600">{(q.error as Error).message}</p> : null}
      {q.data && q.data.length === 0 ? (
        <p className="text-sm text-slate-500">
          {filter === 'pending'
            ? 'No mined examples yet — tap Mine sent mail to analyze your last 200 sent messages.'
            : `No ${filter} examples.`}
        </p>
      ) : null}

      <ul className="space-y-3">
        {(q.data ?? []).map((ex) => (
          <ExampleCard key={ex.id} ex={ex} />
        ))}
      </ul>
    </div>
  );
}

function ExampleCard({ ex }: { ex: StyleExampleView }): JSX.Element {
  const patch = usePatchStyleExample();
  const [editing, setEditing] = useState(false);
  const [contextSummary, setContextSummary] = useState(ex.contextSummary);
  const [replyText, setReplyText] = useState(ex.replyText);
  const [tags, setTags] = useState(ex.tags.join(', '));

  const save = (): void => {
    patch.mutate({
      id: ex.id,
      contextSummary,
      replyText,
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
    });
    setEditing(false);
  };

  return (
    <li className="rounded border border-slate-200 p-3 text-sm">
      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <span className="rounded bg-slate-100 px-1.5 py-0.5">{ex.category ?? 'unknown'}</span>
        {ex.tags.length > 0 ? <span>{ex.tags.join(' · ')}</span> : null}
        <span className="ml-auto uppercase">{ex.status}</span>
      </div>

      {editing ? (
        <div className="space-y-2">
          <textarea
            className="w-full rounded border p-1"
            value={contextSummary}
            onChange={(e) => setContextSummary(e.target.value)}
          />
          <textarea
            className="w-full rounded border p-1"
            rows={4}
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
          />
          <input
            className="w-full rounded border p-1"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="tags, comma-separated"
          />
          <div className="flex gap-2">
            <button type="button" className="rounded bg-slate-800 px-2 py-1 text-white" onClick={save}>
              Save
            </button>
            <button type="button" className="px-2 py-1 text-slate-500" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="text-slate-600">Context: {ex.contextSummary}</p>
          <p className="mt-1 whitespace-pre-wrap">Reply: {ex.replyText}</p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className="rounded bg-emerald-600 px-2 py-1 text-white disabled:opacity-50"
              disabled={patch.isPending}
              onClick={() => patch.mutate({ id: ex.id, status: 'approved' })}
            >
              Approve
            </button>
            <button
              type="button"
              className="rounded bg-slate-200 px-2 py-1 disabled:opacity-50"
              disabled={patch.isPending}
              onClick={() => patch.mutate({ id: ex.id, status: 'rejected' })}
            >
              Reject
            </button>
            <button type="button" className="px-2 py-1 text-slate-500" onClick={() => setEditing(true)}>
              Edit
            </button>
          </div>
        </>
      )}
    </li>
  );
}
```

- [ ] **Step 2: Add the route**

In `apps/service/pwa/src/App.tsx`, add the import:

```ts
import { StyleExamples } from './routes/StyleExamples.js';
```

Add the route inside `<Switch>` (before the catch-all `<Route><Redirect/></Route>`):

```tsx
        <Route path="/voice/examples" component={StyleExamples} />
```

- [ ] **Step 3: Add the Settings entry link**

In `apps/service/pwa/src/routes/Settings.tsx`, add a link to the review screen inside the "Voice / style guide" section (use the existing wouter `Link` import; add it if absent: `import { Link } from 'wouter';`). Place it after the style-guide editor controls:

```tsx
        <Link href="/voice/examples" className="block text-sm text-sky-700 underline">
          Review mined style examples →
        </Link>
```

- [ ] **Step 4: Verify the build**

Run: `pnpm --filter @secretary/pwa build`
Expected: build succeeds (typecheck clean).

- [ ] **Step 5: Commit**

```bash
git add apps/service/pwa/src/routes/StyleExamples.tsx apps/service/pwa/src/App.tsx apps/service/pwa/src/routes/Settings.tsx
git commit -m "feat(6b): PWA review screen + /voice/examples route + Settings entry"
```

---

## Final verification (after all tasks)

- [ ] **Full server suite:** `pnpm --filter @secretary/service test` — all green.
- [ ] **Full PWA suite + build:** `pnpm --filter @secretary/pwa test` then `pnpm --filter @secretary/pwa build`.
- [ ] **Lint/format if configured:** `pnpm -w lint` (root) if present.
- [ ] **Manual runbook** (write `docs/PHASE-6b-MANUAL-VERIFICATION.md`): start the service + gateway + Ollama; (1) Settings → "Review mined style examples" → **Mine sent mail** → progress advances → pending cards appear; Approve one → it moves to Approved and shapes the next generated draft; Reject/Edit behave. (2) On the `secretary test` self-thread, generate a draft, heavily rewrite the body, send → confirm a `draft_heavily_edited` row exists (`action_log`) with `divergencePct` and **no body text**; a light edit logs nothing. (3) **6a spot-check folded in:** style-guide Save/Reset shapes a draft; a contact's `style_notes` appears in its draft prompt.

## Notes for the implementer

- Mining shares the GPU with live draft/classify lanes (one call per lane); it's a deliberate one-time job — note this in the runbook, not a code change.
- Never log message bodies/prompts/completions in `action_log` or server logs (BRIEF §5). The heavy-edit details carry only `threadId`, `version`, `divergencePct`.
- After editing `packages/shared-types/src/domain.ts`, you MUST run `pnpm --filter @secretary/shared-types build` before the service/PWA will typecheck against the new types.
- If `SecretaryError` is not directly constructable (Task 10, Step 3), use the local `ConflictError` subclass shown; confirm by reading `packages/shared-types/src/errors.ts` (or wherever `NotFoundError`/`ValidationError`/`UpstreamError` are defined).
