# Phase 4 — Classification + State Machine + Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Classify inbound email threads with the operator LLM, drive a thread state machine with SLA deadlines, flag SLA breaches as follow-ups, and expose the `needs-attention` / state / classify / contacts APIs that the future PWA consumes.

**Architecture:** A new `apps/service/server/agent/` layer: a pure `StateMachine` (transitions + SLA), a `PromptAssembler` + `Classifier` that call the existing `GatewayClient` and validate JSON with one retry, an in-process sequential `ClassificationQueue`, and a 5-minute `FollowUpEngine`. `SyncManager` routes each touched thread (by its latest message) to either a synchronous outbound transition or an async classify. New/extended repositories back it; new HTTP routes expose it. Classification runs against a **fake `GatewayClient`** in tests and the real Ollama gateway in manual verification.

**Tech Stack:** TypeScript (NodeNext ESM, strict), `better-sqlite3-multiple-ciphers`, Fastify 5, `zod`, `vitest`. Existing patterns: repositories per table, `{data}`/`{error}` envelopes, `SecretaryError` subclasses, `EventBus` → SSE.

---

## Conventions for this plan

- **Run the service test suite:** `pnpm --filter @secretary/service test` (vitest run). To run one file, append a filename substring, e.g. `pnpm --filter @secretary/service test classificationSchema`.
- **Typecheck the service:** `pnpm --filter @secretary/service typecheck`.
- **Build shared-types:** `pnpm --filter @secretary/shared-types build` — REQUIRED after Task 1, because the service imports `@secretary/shared-types` from its built `dist/`. New types are invisible to the service until this runs.
- **ESM import rule:** intra-package imports use `.js` extensions; cross-package use the package name (`@secretary/shared-types`).
- **DB in tests:** `openDatabase(join(dir,'secretary.db'), new InMemorySecretStore())` runs migrations AND `seedSettings` (so `agent.sla.*`, `agent.classify_on_inbound`, `llm.model`, `llm.temperature.classify` are present). Always `db.close()` before `rmSync` (Windows file-lock).
- **Commits:** conventional commits; co-author trailer:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```
  In the Bash tool, commit with a heredoc: `git commit -F - <<'MSG' … MSG` (never `@'…'@`).

---

## File Structure

**Create:**

- `apps/service/server/agent/classificationSchema.ts` — zod schema, JSON schema, `parseClassification`, strict preamble.
- `apps/service/server/agent/StateMachine.ts` — pure transitions + SLA + write helpers.
- `apps/service/server/agent/PromptAssembler.ts` — builds the classification prompt.
- `apps/service/server/agent/Classifier.ts` — assemble → complete → validate → retry → apply.
- `apps/service/server/agent/ClassificationQueue.ts` — sequential in-process queue.
- `apps/service/server/agent/FollowUpEngine.ts` — 5-min SLA-breach cron.
- `apps/service/server/prompts/classifier.md` — classifier system prompt.
- `apps/service/server/db/repositories/FollowUpsRepository.ts` — follow_ups CRUD.
- `apps/service/server/api/contacts.ts` — contacts list/get/patch routes.
- `apps/service/test/helpers/fakeGateway.ts` — scriptable fake `GatewayClient`.
- Test files: `classification-schema.test.ts`, `state-machine.test.ts`, `prompt-assembler.test.ts`, `classifier.test.ts`, `classification-queue.test.ts`, `follow-up-engine.test.ts`, `follow-ups-repository.test.ts`, `contacts-routes.test.ts`. (Plus additions to existing test files.)
- `docs/PHASE-4-MANUAL-VERIFICATION.md`.

**Modify:**

- `packages/shared-types/src/domain.ts` — classification + view types.
- `apps/service/server/db/schema.ts` — `FollowUpRow`.
- `apps/service/server/db/repositories/MessagesRepository.ts` — `insert` returns id; `getById`; `latestForThread`; `latestInboundForThread`.
- `apps/service/server/db/repositories/ThreadsRepository.ts` — `applyClassification`, `setState`, `findNeedsClassification`, `findSlaBreaches`, `needsAttention`.
- `apps/service/server/db/repositories/ContactsRepository.ts` — `getById`, `list`, `patch`.
- `apps/service/server/sync/SyncManager.ts` — chronological sort + per-thread post-batch routing + optional hooks.
- `apps/service/server/api/threads.ts` — needs-attention, state, classify routes.
- `apps/service/server/server.ts` — `ServerDeps` gains `classificationQueue` + `stateMachine`; register contacts routes.
- `apps/service/server/index.ts` — compose the agent layer; build gateway if configured; start follow-up engine; startup recovery.
- `apps/service/test/helpers/testServer.ts` — provide `classificationQueue` + `stateMachine`.
- `apps/service/test/messages-repository.test.ts` — update for `insert` returning id.
- `BRIEF.md` — record the four deviations.

---

### Task 1: Shared types for classification + views

**Files:**

- Modify: `packages/shared-types/src/domain.ts`

- [ ] **Step 1: Add the types**

Append to `packages/shared-types/src/domain.ts` (after the existing `ThreadWithMessages` interface):

```typescript
export type ClassificationIntent =
  | 'inquiry'
  | 'booking_request'
  | 'scheduling'
  | 'chitchat'
  | 'question'
  | 'complaint'
  | 'other';

/** The validated result of classifying one inbound message (BRIEF §11). */
export interface ClassificationResult {
  intent: ClassificationIntent;
  category_suggestion: ContactCategory;
  urgency: Urgency;
  requires_response: boolean;
  summary: string;
}

/** A row on the Needs Attention screen (BRIEF §9 / §12). */
export interface NeedsAttentionItem extends ThreadSummary {
  urgency: Urgency | null;
  slaDeadline: string | null;
  summary: string | null;
  hasPendingFollowUp: boolean;
}

/** Contact as returned by the contacts API (ISO dates per §16). */
export interface ContactView {
  id: string;
  emailAddress: string;
  displayName: string | null;
  category: ContactCategory;
  notes: string | null;
  doNotAutoDraft: boolean;
  totalMessagesIn: number;
  totalMessagesOut: number;
  lastContactAt: string | null;
}
```

- [ ] **Step 2: Build shared-types and verify it compiles**

Run: `pnpm --filter @secretary/shared-types build`
Expected: `tsc` exits 0; `packages/shared-types/dist/domain.d.ts` now contains `ClassificationResult`, `NeedsAttentionItem`, `ContactView`.

(No runtime test: these are type-only declarations with no behavior. They are exercised by every later task's tests, which fail to compile if a name is wrong.)

- [ ] **Step 3: Commit**

```bash
git add packages/shared-types/src/domain.ts packages/shared-types/dist
git commit -F - <<'MSG'
feat(shared-types): classification result + needs-attention/contact views

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 2: Classification schema + parser

**Files:**

- Create: `apps/service/server/agent/classificationSchema.ts`
- Test: `apps/service/test/classification-schema.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/service/test/classification-schema.test.ts`:

````typescript
import { describe, expect, it } from 'vitest';
import { parseClassification } from '../server/agent/classificationSchema.js';

describe('parseClassification', () => {
  it('parses a clean JSON object', () => {
    const r = parseClassification(
      '{"intent":"booking_request","category_suggestion":"client_new","urgency":"high","requires_response":true,"summary":"Wants to book a shoot"}',
    );
    expect(r).toEqual({
      intent: 'booking_request',
      category_suggestion: 'client_new',
      urgency: 'high',
      requires_response: true,
      summary: 'Wants to book a shoot',
    });
  });

  it('strips ```json fences', () => {
    const r = parseClassification(
      '```json\n{"intent":"question","category_suggestion":"unknown","urgency":"normal","requires_response":true,"summary":"A question"}\n```',
    );
    expect(r?.intent).toBe('question');
  });

  it('extracts the JSON object when wrapped in prose', () => {
    const r = parseClassification(
      'Sure! Here is the result: {"requires_response":false,"summary":"FYI"} Hope that helps.',
    );
    expect(r?.requires_response).toBe(false);
  });

  it('coerces stringy booleans and unknown enum values to safe defaults', () => {
    const r = parseClassification(
      '{"intent":"weird","category_suggestion":"nonsense","urgency":"URGENT","requires_response":"true","summary":"x"}',
    );
    expect(r).toEqual({
      intent: 'other',
      category_suggestion: 'unknown',
      urgency: 'normal',
      requires_response: true,
      summary: 'x',
    });
  });

  it('clamps summary to 140 chars and defaults a missing summary to empty', () => {
    const long = 'a'.repeat(200);
    const r = parseClassification(`{"requires_response":true,"summary":"${long}"}`);
    expect(r?.summary).toHaveLength(140);
    const r2 = parseClassification('{"requires_response":true}');
    expect(r2?.summary).toBe('');
  });

  it('returns null when requires_response is missing or the body is garbage', () => {
    expect(parseClassification('{"summary":"no decision"}')).toBeNull();
    expect(parseClassification('not json at all')).toBeNull();
  });
});
````

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @secretary/service test classification-schema`
Expected: FAIL — cannot find module `../server/agent/classificationSchema.js`.

- [ ] **Step 3: Implement the schema and parser**

Create `apps/service/server/agent/classificationSchema.ts`:

````typescript
import { z } from 'zod';
import type { ClassificationResult } from '@secretary/shared-types';

const INTENTS = [
  'inquiry',
  'booking_request',
  'scheduling',
  'chitchat',
  'question',
  'complaint',
  'other',
] as const;
const CATEGORIES = [
  'client_established',
  'client_new',
  'screening',
  'personal',
  'vendor',
  'noise',
  'unknown',
] as const;
const URGENCIES = ['low', 'normal', 'high'] as const;

/** Coerce any value to a member of `vals`, falling back to `fallback` (small models drift). */
function lenient<T extends readonly string[]>(vals: T, fallback: T[number]): z.ZodType<T[number]> {
  return z
    .any()
    .transform((v) => ((vals as readonly string[]).includes(v) ? v : fallback)) as z.ZodType<
    T[number]
  >;
}

export const classificationResultSchema = z.object({
  intent: lenient(INTENTS, 'other'),
  category_suggestion: lenient(CATEGORIES, 'unknown'),
  urgency: lenient(URGENCIES, 'normal'),
  // The decisive field — must be present and boolean-ish, else we treat the parse as failed.
  requires_response: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true'),
  summary: z
    .string()
    .optional()
    .transform((s) => (s ?? '').slice(0, 140)),
});

/** JSON schema passed to the gateway (advisory; we always re-validate with zod). */
export const CLASSIFICATION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: [...INTENTS] },
    category_suggestion: { type: 'string', enum: [...CATEGORIES] },
    urgency: { type: 'string', enum: [...URGENCIES] },
    requires_response: { type: 'boolean' },
    summary: { type: 'string' },
  },
  required: ['intent', 'category_suggestion', 'urgency', 'requires_response', 'summary'],
} as const;

export const STRICT_JSON_PREAMBLE =
  'You MUST respond with a single valid JSON object and nothing else. No markdown, no code fences, no commentary, no trailing text.';

/** Best-effort parse of a model completion into a ClassificationResult. Returns null on failure. */
export function parseClassification(raw: string): ClassificationResult | null {
  const candidate = extractJson(raw);
  if (candidate === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch {
    return null;
  }
  const parsed = classificationResultSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Pulls a JSON object string out of a completion: strips fences, else grabs the first {...}. */
function extractJson(raw: string): string | null {
  const trimmed = raw.trim();
  const fenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  if (fenced.startsWith('{')) return fenced;
  const match = fenced.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
}
````

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @secretary/service test classification-schema`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/service/server/agent/classificationSchema.ts apps/service/test/classification-schema.test.ts
git commit -F - <<'MSG'
feat(service): classification result schema + lenient JSON parser

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 3: MessagesRepository — return id, lookups by id / latest

**Files:**

- Modify: `apps/service/server/db/repositories/MessagesRepository.ts`
- Modify (existing test): `apps/service/test/messages-repository.test.ts`

- [ ] **Step 1: Read the existing test, then update + extend it**

First read `apps/service/test/messages-repository.test.ts` to see the current `insert` assertions. Replace any assertion that treats `insert(...)` as a boolean (e.g. `expect(repo.insert(...)).toBe(true)`) with the new behavior, and add the new cases. The relevant `describe` block should contain:

```typescript
it('insert returns the new id and is idempotent on (account_id, provider_id)', () => {
  const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
  db.prepare(
    `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','a@b.com')`,
  ).run();
  const threads = new ThreadsRepository(db);
  const threadId = threads.create('acc1', 'hello', ['a@b.com'], 1000);
  const repo = new MessagesRepository(db);

  const id = repo.insert('acc1', threadId, raw('u1', 'inbound', 1000));
  expect(id).toMatch(/[0-9a-f-]{36}/);
  const again = repo.insert('acc1', threadId, raw('u1', 'inbound', 1000)); // duplicate provider_id
  db.close();
  expect(again).toBeNull();
});

it('getById, latestForThread, latestInboundForThread', () => {
  const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
  db.prepare(
    `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','a@b.com')`,
  ).run();
  const threads = new ThreadsRepository(db);
  const threadId = threads.create('acc1', 'hello', ['a@b.com'], 1000);
  const repo = new MessagesRepository(db);

  const inId = repo.insert('acc1', threadId, raw('u1', 'inbound', 1000))!;
  const outId = repo.insert('acc1', threadId, raw('u2', 'outbound', 2000))!;

  expect(repo.getById(inId)?.id).toBe(inId);
  expect(repo.getById('nope')).toBeUndefined();
  expect(repo.latestForThread(threadId)?.id).toBe(outId); // newest overall
  expect(repo.latestInboundForThread(threadId)?.id).toBe(inId); // newest inbound
});
```

Add a `raw` helper near the top of the file (a minimal `RawMessage`; outbound uses `dateSent`, inbound uses `dateReceived` so the COALESCE ordering is exercised):

```typescript
import type { RawMessage, MessageDirection } from '@secretary/shared-types';
import { ThreadsRepository } from '../server/db/repositories/ThreadsRepository.js';

function raw(uid: string, direction: MessageDirection, when: number): RawMessage {
  return {
    providerId: uid,
    references: [],
    from: direction === 'inbound' ? { address: 'a@b.com' } : { address: 'me@b.com' },
    to: [{ address: direction === 'inbound' ? 'me@b.com' : 'a@b.com' }],
    cc: [],
    bcc: [],
    subject: 'hello',
    bodyText: 'hi',
    direction,
    ...(direction === 'inbound' ? { dateReceived: when } : { dateSent: when }),
    isRead: false,
    isStarred: false,
    folder: direction === 'inbound' ? 'INBOX' : 'Sent',
    labels: [],
    attachmentsMeta: [],
  };
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @secretary/service test messages-repository`
Expected: FAIL — `insert` returns `boolean`/`true`, not a uuid string; `getById`/`latestForThread`/`latestInboundForThread` are not functions.

- [ ] **Step 3: Implement the changes**

In `apps/service/server/db/repositories/MessagesRepository.ts`, change `insert` to capture and return the generated id, and add the three lookups. The full file:

```typescript
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3-multiple-ciphers';
import type { RawMessage } from '@secretary/shared-types';
import type { MessageRow } from '../schema.js';

export class MessagesRepository {
  constructor(private readonly db: Database.Database) {}

  /** Inserts a message; returns its new id, or null if (account_id, provider_id) already exists. */
  insert(accountId: string, threadId: string, raw: RawMessage): string | null {
    const id = randomUUID();
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages
          (id, account_id, provider_id, thread_id, message_id_header, in_reply_to, references_header,
           from_address, from_name, to_addresses, cc_addresses, bcc_addresses, subject, body_text,
           body_html, snippet, direction, date_sent, date_received, is_read, is_starred, folder,
           labels, attachments_meta, raw_size_bytes, synced_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        accountId,
        raw.providerId,
        threadId,
        raw.messageIdHeader ?? null,
        raw.inReplyTo ?? null,
        JSON.stringify(raw.references),
        raw.from.address,
        raw.from.name ?? null,
        JSON.stringify(raw.to),
        JSON.stringify(raw.cc),
        JSON.stringify(raw.bcc),
        raw.subject ?? null,
        raw.bodyText ?? null,
        raw.bodyHtml ?? null,
        raw.snippet ?? null,
        raw.direction,
        raw.dateSent ?? null,
        raw.dateReceived ?? null,
        raw.isRead ? 1 : 0,
        raw.isStarred ? 1 : 0,
        raw.folder,
        JSON.stringify(raw.labels),
        JSON.stringify(raw.attachmentsMeta),
        raw.rawSizeBytes ?? null,
        Date.now(),
      );
    return info.changes > 0 ? id : null;
  }

  existsByProviderId(accountId: string, providerId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 AS x FROM messages WHERE account_id = ? AND provider_id = ? LIMIT 1')
      .get(accountId, providerId) as { x: number } | undefined;
    return row !== undefined;
  }

  getById(id: string): MessageRow | undefined {
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
  }

  listByThread(threadId: string): MessageRow[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY COALESCE(date_received, 0) ASC')
      .all(threadId) as MessageRow[];
  }

  /** Newest message in the thread by received-or-sent time. */
  latestForThread(threadId: string): MessageRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM messages WHERE thread_id = ?
         ORDER BY COALESCE(date_received, date_sent, 0) DESC LIMIT 1`,
      )
      .get(threadId) as MessageRow | undefined;
  }

  /** Newest inbound message in the thread (the one a classifier should look at). */
  latestInboundForThread(threadId: string): MessageRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM messages WHERE thread_id = ? AND direction = 'inbound'
         ORDER BY COALESCE(date_received, date_sent, 0) DESC LIMIT 1`,
      )
      .get(threadId) as MessageRow | undefined;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @secretary/service test messages-repository`
Expected: PASS.

Then check no other code broke on the `insert` return change:
Run: `pnpm --filter @secretary/service typecheck`
Expected: exits 0. (`SyncManager.persist` calls `this.messages.insert(...)` without using the return value yet — still fine. It is updated in Task 13.)

- [ ] **Step 5: Commit**

```bash
git add apps/service/server/db/repositories/MessagesRepository.ts apps/service/test/messages-repository.test.ts
git commit -F - <<'MSG'
feat(service): MessagesRepository returns id; add getById/latest lookups

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 4: ThreadsRepository — classification writes + attention/breach queries

**Files:**

- Modify: `apps/service/server/db/repositories/ThreadsRepository.ts`
- Test: `apps/service/test/threads-repository.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

Append these tests inside the existing `describe('ThreadsRepository', …)` block in `apps/service/test/threads-repository.test.ts`:

```typescript
it('applyClassification + setState update the right columns', () => {
  const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
  withAccount(db);
  const repo = new ThreadsRepository(db);
  const id = repo.create('acc1', 'hello', ['a@b.com'], 1000);

  repo.applyClassification(id, {
    state: 'awaiting_your_reply',
    urgency: 'high',
    summary: 'Needs a reply',
    slaDeadline: 5000,
    stateChangedAt: 2000,
    stateReason: 'classified',
  });
  let t = repo.get(id)!;
  expect([t.state, t.urgency, t.last_agent_summary, t.sla_deadline]).toEqual([
    'awaiting_your_reply',
    'high',
    'Needs a reply',
    5000,
  ]);

  repo.setState(id, {
    state: 'awaiting_their_reply',
    slaDeadline: 9000,
    stateChangedAt: 3000,
    stateReason: 'outbound_sent',
  });
  t = repo.get(id)!;
  expect([t.state, t.sla_deadline, t.urgency]).toEqual(['awaiting_their_reply', 9000, 'high']); // urgency untouched
});

it('findNeedsClassification returns only unclassified threads', () => {
  const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
  withAccount(db);
  const repo = new ThreadsRepository(db);
  const a = repo.create('acc1', 'a', [], 1000);
  const b = repo.create('acc1', 'b', [], 2000);
  repo.setState(b, {
    state: 'awaiting_your_reply',
    slaDeadline: null,
    stateChangedAt: 1,
    stateReason: 'x',
  });
  const ids = repo.findNeedsClassification().map((t) => t.id);
  db.close();
  expect(ids).toEqual([a]);
});

it('findSlaBreaches finds overdue active threads without a pending follow-up', () => {
  const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
  withAccount(db);
  const repo = new ThreadsRepository(db);
  const overdue = repo.create('acc1', 'overdue', [], 1000);
  const future = repo.create('acc1', 'future', [], 1000);
  const informational = repo.create('acc1', 'fyi', [], 1000);
  repo.setState(overdue, {
    state: 'awaiting_your_reply',
    slaDeadline: 500,
    stateChangedAt: 1,
    stateReason: 'x',
  });
  repo.setState(future, {
    state: 'awaiting_your_reply',
    slaDeadline: 9999,
    stateChangedAt: 1,
    stateReason: 'x',
  });
  repo.setState(informational, {
    state: 'informational',
    slaDeadline: 500,
    stateChangedAt: 1,
    stateReason: 'x',
  });

  let ids = repo.findSlaBreaches(1000).map((t) => t.id);
  expect(ids).toEqual([overdue]); // future not due; informational not an active state

  db.prepare(
    `INSERT INTO follow_ups (id, thread_id, trigger_at, reason, status, created_at)
     VALUES ('f1', ?, 1000, 'sla_breach', 'pending', 1000)`,
  ).run(overdue);
  ids = repo.findSlaBreaches(1000).map((t) => t.id);
  db.close();
  expect(ids).toEqual([]); // suppressed once a pending follow-up exists
});

it('needsAttention returns awaiting_your_reply plus pending-follow-up threads, urgency then SLA ordered', () => {
  const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
  withAccount(db);
  const repo = new ThreadsRepository(db);
  const high = repo.create('acc1', 'high', [], 1000);
  const normalSoon = repo.create('acc1', 'normal-soon', [], 1000);
  const normalLate = repo.create('acc1', 'normal-late', [], 1000);
  const followUpOnly = repo.create('acc1', 'follow', [], 1000);
  const ignored = repo.create('acc1', 'ignored', [], 1000);

  repo.applyClassification(high, {
    state: 'awaiting_your_reply',
    urgency: 'high',
    summary: 's',
    slaDeadline: 8000,
    stateChangedAt: 1,
    stateReason: 'x',
  });
  repo.applyClassification(normalSoon, {
    state: 'awaiting_your_reply',
    urgency: 'normal',
    summary: 's',
    slaDeadline: 3000,
    stateChangedAt: 1,
    stateReason: 'x',
  });
  repo.applyClassification(normalLate, {
    state: 'awaiting_your_reply',
    urgency: 'normal',
    summary: 's',
    slaDeadline: 9000,
    stateChangedAt: 1,
    stateReason: 'x',
  });
  repo.setState(followUpOnly, {
    state: 'awaiting_their_reply',
    slaDeadline: 1,
    stateChangedAt: 1,
    stateReason: 'x',
  });
  repo.setState(ignored, {
    state: 'closed',
    slaDeadline: null,
    stateChangedAt: 1,
    stateReason: 'x',
  });
  db.prepare(
    `INSERT INTO follow_ups (id, thread_id, trigger_at, reason, status, created_at)
     VALUES ('f1', ?, 1, 'sla_breach', 'pending', 1)`,
  ).run(followUpOnly);

  const rows = repo.needsAttention();
  db.close();
  // high urgency first; then normal by sla asc; follow-up-only thread (null urgency) last; closed excluded.
  expect(rows.map((r) => r.id)).toEqual([high, normalSoon, normalLate, followUpOnly]);
  expect(rows.find((r) => r.id === followUpOnly)?.has_pending).toBe(1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @secretary/service test threads-repository`
Expected: FAIL — `applyClassification`/`setState`/`findNeedsClassification`/`findSlaBreaches`/`needsAttention` are not functions.

- [ ] **Step 3: Implement the methods**

In `apps/service/server/db/repositories/ThreadsRepository.ts`, add the imports/types and methods. Add to the top imports:

```typescript
import type { ThreadState, Urgency } from '@secretary/shared-types';
```

Add these interfaces above the class:

```typescript
export interface ClassificationUpdate {
  state: ThreadState;
  urgency: Urgency;
  summary: string;
  slaDeadline: number | null;
  stateChangedAt: number;
  stateReason: string;
}

export interface StateUpdate {
  state: ThreadState;
  slaDeadline: number | null;
  stateChangedAt: number;
  stateReason: string;
}

/** A thread row plus whether it has a pending follow-up (for the needs-attention view). */
export type AttentionRow = ThreadRow & { has_pending: number };
```

Add these methods inside the class (after `listByAccount`):

```typescript
  applyClassification(id: string, u: ClassificationUpdate): void {
    this.db
      .prepare(
        `UPDATE threads SET
           state = ?, urgency = ?, last_agent_summary = ?, sla_deadline = ?,
           state_changed_at = ?, state_reason = ?
         WHERE id = ?`,
      )
      .run(u.state, u.urgency, u.summary, u.slaDeadline, u.stateChangedAt, u.stateReason, id);
  }

  setState(id: string, u: StateUpdate): void {
    this.db
      .prepare(
        `UPDATE threads SET state = ?, sla_deadline = ?, state_changed_at = ?, state_reason = ?
         WHERE id = ?`,
      )
      .run(u.state, u.slaDeadline, u.stateChangedAt, u.stateReason, id);
  }

  findNeedsClassification(): ThreadRow[] {
    return this.db
      .prepare("SELECT * FROM threads WHERE state = 'needs_classification'")
      .all() as ThreadRow[];
  }

  /** Overdue threads in an active state with no pending follow-up (BRIEF §11 follow-up engine). */
  findSlaBreaches(now: number): ThreadRow[] {
    return this.db
      .prepare(
        `SELECT * FROM threads t
         WHERE t.sla_deadline IS NOT NULL
           AND t.sla_deadline < ?
           AND t.state IN ('awaiting_your_reply','awaiting_their_reply')
           AND NOT EXISTS (
             SELECT 1 FROM follow_ups f WHERE f.thread_id = t.id AND f.status = 'pending'
           )`,
      )
      .all(now) as ThreadRow[];
  }

  /** awaiting_your_reply OR has a pending follow-up; urgency DESC then sla_deadline ASC (nulls last). */
  needsAttention(): AttentionRow[] {
    return this.db
      .prepare(
        `SELECT t.*,
                EXISTS (SELECT 1 FROM follow_ups f WHERE f.thread_id = t.id AND f.status = 'pending') AS has_pending
         FROM threads t
         WHERE t.state = 'awaiting_your_reply'
            OR EXISTS (SELECT 1 FROM follow_ups f WHERE f.thread_id = t.id AND f.status = 'pending')
         ORDER BY
           CASE t.urgency WHEN 'high' THEN 0 WHEN 'normal' THEN 1 WHEN 'low' THEN 2 ELSE 3 END ASC,
           CASE WHEN t.sla_deadline IS NULL THEN 1 ELSE 0 END ASC,
           t.sla_deadline ASC`,
      )
      .all() as AttentionRow[];
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @secretary/service test threads-repository`
Expected: PASS (original 2 + 4 new).

- [ ] **Step 5: Commit**

```bash
git add apps/service/server/db/repositories/ThreadsRepository.ts apps/service/test/threads-repository.test.ts
git commit -F - <<'MSG'
feat(service): ThreadsRepository classification writes + attention/breach queries

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 5: ContactsRepository — getById / list / patch

**Files:**

- Modify: `apps/service/server/db/repositories/ContactsRepository.ts`
- Test: `apps/service/test/contacts-repository.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe('ContactsRepository', …)`:

```typescript
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
    styleNotes: { tone: 'warm' },
  });
  expect(updated?.category).toBe('client_new');
  expect(updated?.notes).toBe('Met at the expo');
  expect(updated?.do_not_auto_draft).toBe(1);
  expect(JSON.parse(updated!.style_notes!)).toEqual({ tone: 'warm' });

  expect(repo.list({ category: 'client_new', limit: 10, offset: 0 }).map((c) => c.id)).toEqual([
    alice.id,
  ]);
  db.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @secretary/service test contacts-repository`
Expected: FAIL — `getById`/`list`/`patch` are not functions.

- [ ] **Step 3: Implement the methods**

In `apps/service/server/db/repositories/ContactsRepository.ts`, add the import and methods. Update the top import line:

```typescript
import type { ContactCategory, EmailAddress, MessageDirection } from '@secretary/shared-types';
```

Add this interface above the class:

```typescript
export interface ContactPatch {
  category?: ContactCategory;
  notes?: string;
  styleNotes?: unknown;
  doNotAutoDraft?: boolean;
}
```

Add these methods inside the class (after `recordSeen`):

```typescript
  getById(id: string): ContactRow | undefined {
    return this.db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as ContactRow | undefined;
  }

  list(opts: { category?: ContactCategory; limit: number; offset: number }): ContactRow[] {
    if (opts.category) {
      return this.db
        .prepare(
          `SELECT * FROM contacts WHERE category = ?
           ORDER BY COALESCE(last_contact_at, 0) DESC LIMIT ? OFFSET ?`,
        )
        .all(opts.category, opts.limit, opts.offset) as ContactRow[];
    }
    return this.db
      .prepare(
        `SELECT * FROM contacts ORDER BY COALESCE(last_contact_at, 0) DESC LIMIT ? OFFSET ?`,
      )
      .all(opts.limit, opts.offset) as ContactRow[];
  }

  /** Updates only the provided fields; returns the updated row. */
  patch(id: string, fields: ContactPatch): ContactRow | undefined {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (fields.category !== undefined) {
      sets.push('category = ?');
      vals.push(fields.category);
    }
    if (fields.notes !== undefined) {
      sets.push('notes = ?');
      vals.push(fields.notes);
    }
    if (fields.styleNotes !== undefined) {
      sets.push('style_notes = ?');
      vals.push(JSON.stringify(fields.styleNotes));
    }
    if (fields.doNotAutoDraft !== undefined) {
      sets.push('do_not_auto_draft = ?');
      vals.push(fields.doNotAutoDraft ? 1 : 0);
    }
    if (sets.length > 0) {
      this.db.prepare(`UPDATE contacts SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    }
    return this.getById(id);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @secretary/service test contacts-repository`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/service/server/db/repositories/ContactsRepository.ts apps/service/test/contacts-repository.test.ts
git commit -F - <<'MSG'
feat(service): ContactsRepository getById/list/patch

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 6: FollowUpsRepository + FollowUpRow

**Files:**

- Modify: `apps/service/server/db/schema.ts`
- Create: `apps/service/server/db/repositories/FollowUpsRepository.ts`
- Test: `apps/service/test/follow-ups-repository.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/service/test/follow-ups-repository.test.ts`:

```typescript
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemorySecretStore } from '../server/auth/SecretStore.js';
import { openDatabase } from '../server/db/connection.js';
import { ThreadsRepository } from '../server/db/repositories/ThreadsRepository.js';
import { FollowUpsRepository } from '../server/db/repositories/FollowUpsRepository.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secretary-followups-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('FollowUpsRepository', () => {
  it('inserts, reports pending, lists, dismisses and resolves', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','a@b.com')`,
    ).run();
    const threadId = new ThreadsRepository(db).create('acc1', 'hello', [], 1000);
    const repo = new FollowUpsRepository(db);

    expect(repo.hasPending(threadId)).toBe(false);
    const id = repo.insert({ threadId, triggerAt: 1000, reason: 'sla_breach', createdAt: 1000 });
    expect(id).toMatch(/[0-9a-f-]{36}/);
    expect(repo.hasPending(threadId)).toBe(true);
    expect(repo.listPending().map((f) => f.id)).toEqual([id]);

    repo.dismiss(id);
    expect(repo.hasPending(threadId)).toBe(false);
    expect(repo.listPending()).toHaveLength(0);

    const id2 = repo.insert({ threadId, triggerAt: 2000, reason: 'sla_breach', createdAt: 2000 });
    repo.resolve(id2);
    const row = db.prepare('SELECT status, resolved_at FROM follow_ups WHERE id = ?').get(id2) as {
      status: string;
      resolved_at: number | null;
    };
    db.close();
    expect(row.status).toBe('resolved');
    expect(row.resolved_at).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @secretary/service test follow-ups-repository`
Expected: FAIL — cannot find module `FollowUpsRepository.js`.

- [ ] **Step 3: Add the row type**

In `apps/service/server/db/schema.ts`, append after `ActionLogRow`:

```typescript
export interface FollowUpRow {
  id: string;
  thread_id: string;
  trigger_at: number;
  reason: 'sla_breach' | 'scheduled_reminder' | 'awaiting_response' | 'manual_pin';
  description: string | null;
  status: 'pending' | 'surfaced' | 'dismissed' | 'resolved';
  created_at: number | null;
  surfaced_at: number | null;
  resolved_at: number | null;
}
```

- [ ] **Step 4: Implement the repository**

Create `apps/service/server/db/repositories/FollowUpsRepository.ts`:

```typescript
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3-multiple-ciphers';
import type { FollowUpRow } from '../schema.js';

export interface FollowUpInsert {
  threadId: string;
  triggerAt: number;
  reason: FollowUpRow['reason'];
  description?: string;
  status?: FollowUpRow['status'];
  createdAt: number;
}

export class FollowUpsRepository {
  constructor(private readonly db: Database.Database) {}

  insert(input: FollowUpInsert): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO follow_ups (id, thread_id, trigger_at, reason, description, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.threadId,
        input.triggerAt,
        input.reason,
        input.description ?? null,
        input.status ?? 'pending',
        input.createdAt,
      );
    return id;
  }

  hasPending(threadId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS x FROM follow_ups WHERE thread_id = ? AND status = 'pending' LIMIT 1")
      .get(threadId) as { x: number } | undefined;
    return row !== undefined;
  }

  listPending(): FollowUpRow[] {
    return this.db
      .prepare("SELECT * FROM follow_ups WHERE status = 'pending' ORDER BY trigger_at ASC")
      .all() as FollowUpRow[];
  }

  dismiss(id: string): void {
    this.db.prepare("UPDATE follow_ups SET status = 'dismissed' WHERE id = ?").run(id);
  }

  resolve(id: string, now: number = Date.now()): void {
    this.db
      .prepare("UPDATE follow_ups SET status = 'resolved', resolved_at = ? WHERE id = ?")
      .run(now, id);
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @secretary/service test follow-ups-repository`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/service/server/db/schema.ts apps/service/server/db/repositories/FollowUpsRepository.ts apps/service/test/follow-ups-repository.test.ts
git commit -F - <<'MSG'
feat(service): FollowUpsRepository + FollowUpRow

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 7: StateMachine — transitions + SLA + write helpers

**Files:**

- Create: `apps/service/server/agent/StateMachine.ts`
- Test: `apps/service/test/state-machine.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/service/test/state-machine.test.ts`:

```typescript
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClassificationResult, ThreadState } from '@secretary/shared-types';
import { InMemorySecretStore } from '../server/auth/SecretStore.js';
import { openDatabase } from '../server/db/connection.js';
import { ActionLogRepository } from '../server/db/repositories/ActionLogRepository.js';
import { ContactsRepository } from '../server/db/repositories/ContactsRepository.js';
import { SettingsRepository } from '../server/db/repositories/SettingsRepository.js';
import { ThreadsRepository } from '../server/db/repositories/ThreadsRepository.js';
import { EventBus } from '../server/eventBus.js';
import {
  nextStateForInbound,
  nextStateForOutbound,
  StateMachine,
} from '../server/agent/StateMachine.js';
import type { MessageRow, ThreadRow } from '../server/db/schema.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secretary-sm-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('nextStateForInbound', () => {
  const cases: Array<[ThreadState, boolean, ThreadState]> = [
    ['needs_classification', true, 'awaiting_your_reply'],
    ['needs_classification', false, 'informational'],
    ['awaiting_their_reply', true, 'awaiting_your_reply'],
    ['awaiting_their_reply', false, 'informational'],
    ['awaiting_your_reply', true, 'awaiting_your_reply'],
    ['awaiting_your_reply', false, 'awaiting_your_reply'],
    ['informational', true, 'awaiting_your_reply'],
    ['informational', false, 'informational'],
    ['scheduled_followup', true, 'awaiting_your_reply'],
    ['scheduled_followup', false, 'scheduled_followup'],
    ['closed', true, 'awaiting_your_reply'],
    ['closed', false, 'closed'],
  ];
  it.each(cases)('%s + requires=%s -> %s', (prev, requires, expected) => {
    expect(nextStateForInbound(prev, requires)).toBe(expected);
  });
  it('outbound is always awaiting_their_reply', () => {
    expect(nextStateForOutbound()).toBe('awaiting_their_reply');
  });
});

function makeSM(db: ReturnType<typeof openDatabase>, now = () => 10_000): StateMachine {
  return new StateMachine(
    new ThreadsRepository(db),
    new ContactsRepository(db),
    new SettingsRepository(db),
    new ActionLogRepository(db),
    new EventBus(),
    now,
  );
}

describe('StateMachine SLA + writes', () => {
  it('computes awaiting_your_reply SLA from last_inbound_at by contact category', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    const sm = makeSM(db);
    const thread = { last_inbound_at: 1_000, last_outbound_at: null } as ThreadRow;
    // client_new = 4h (seeded), client_established = 12h, unknown -> 24h fallback
    expect(sm.computeSlaDeadline('awaiting_your_reply', 'client_new', thread)).toBe(
      1_000 + 4 * 3_600_000,
    );
    expect(sm.computeSlaDeadline('awaiting_your_reply', 'client_established', thread)).toBe(
      1_000 + 12 * 3_600_000,
    );
    expect(sm.computeSlaDeadline('awaiting_your_reply', 'vendor', thread)).toBe(
      1_000 + 24 * 3_600_000,
    );
    db.close();
  });

  it('computes awaiting_their_reply SLA from last_outbound_at and nulls non-active states', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    const sm = makeSM(db);
    const thread = { last_inbound_at: null, last_outbound_at: 2_000 } as ThreadRow;
    expect(sm.computeSlaDeadline('awaiting_their_reply', 'unknown', thread)).toBe(
      2_000 + 72 * 3_600_000,
    );
    expect(sm.computeSlaDeadline('informational', 'unknown', thread)).toBeNull();
    expect(sm.computeSlaDeadline('closed', 'unknown', thread)).toBeNull();
    db.close();
  });

  it('onInboundClassified returns state/urgency/sla using the sender category', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','a@b.com')`,
    ).run();
    const contacts = new ContactsRepository(db);
    contacts.recordSeen({ address: 'vip@client.com' }, 'inbound', 500);
    contacts.patch(contacts.findByEmail('vip@client.com')!.id, { category: 'client_new' });
    const sm = makeSM(db);
    const thread = {
      state: 'needs_classification',
      last_inbound_at: 1_000,
      last_outbound_at: null,
    } as ThreadRow;
    const result: ClassificationResult = {
      intent: 'booking_request',
      category_suggestion: 'client_new',
      urgency: 'high',
      requires_response: true,
      summary: 'Wants a booking',
    };
    const message = { from_address: 'vip@client.com' } as MessageRow;
    const out = sm.onInboundClassified(thread, result, message);
    db.close();
    expect(out).toEqual({
      state: 'awaiting_your_reply',
      urgency: 'high',
      slaDeadline: 1_000 + 4 * 3_600_000,
    });
  });

  it('onOutbound writes awaiting_their_reply + SLA and logs', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','a@b.com')`,
    ).run();
    const threads = new ThreadsRepository(db);
    const id = threads.create('acc1', 'hi', [], 1000);
    threads.touch(id, { lastOutboundAt: 2_000 });
    makeSM(db).onOutbound(id);
    const t = threads.get(id)!;
    const log = db
      .prepare("SELECT COUNT(*) AS n FROM action_log WHERE action='state_outbound'")
      .get() as { n: number };
    db.close();
    expect(t.state).toBe('awaiting_their_reply');
    expect(t.sla_deadline).toBe(2_000 + 72 * 3_600_000);
    expect(log.n).toBe(1);
  });

  it('onManual sets the state, clears SLA for closed, and logs a user override', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','a@b.com')`,
    ).run();
    const threads = new ThreadsRepository(db);
    const id = threads.create('acc1', 'hi', [], 1000);
    makeSM(db).onManual(id, 'closed', 'handled offline');
    const t = threads.get(id)!;
    const log = db.prepare("SELECT actor FROM action_log WHERE action='state_override'").get() as {
      actor: string;
    };
    db.close();
    expect(t.state).toBe('closed');
    expect(t.sla_deadline).toBeNull();
    expect(log.actor).toBe('user');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @secretary/service test state-machine`
Expected: FAIL — cannot find module `StateMachine.js`.

- [ ] **Step 3: Implement the StateMachine**

Create `apps/service/server/agent/StateMachine.ts`:

```typescript
import {
  NotFoundError,
  type ClassificationResult,
  type ContactCategory,
  type ThreadState,
} from '@secretary/shared-types';
import type { ContactsRepository } from '../db/repositories/ContactsRepository.js';
import type { SettingsRepository } from '../db/repositories/SettingsRepository.js';
import type { ThreadsRepository } from '../db/repositories/ThreadsRepository.js';
import type { ActionLogRepository } from '../db/repositories/ActionLogRepository.js';
import type { EventBus } from '../eventBus.js';
import type { MessageRow, ThreadRow } from '../db/schema.js';

const HOUR_MS = 3_600_000;
const DEFAULT_AWAITING_YOUR_REPLY_HOURS = 24;
const DEFAULT_AWAITING_THEIR_REPLY_HOURS = 72;

/** Pure: the new state for an inbound message given the previous state (BRIEF §11.1, extended). */
export function nextStateForInbound(prev: ThreadState, requiresResponse: boolean): ThreadState {
  if (requiresResponse) return 'awaiting_your_reply';
  if (prev === 'awaiting_their_reply' || prev === 'needs_classification') return 'informational';
  return prev; // awaiting_your_reply / informational / scheduled_followup / closed: unchanged
}

/** Pure: outbound always moves the thread to awaiting_their_reply. */
export function nextStateForOutbound(): ThreadState {
  return 'awaiting_their_reply';
}

export interface ClassifiedTransition {
  state: ThreadState;
  urgency: ClassificationResult['urgency'];
  slaDeadline: number | null;
}

export class StateMachine {
  constructor(
    private readonly threads: ThreadsRepository,
    private readonly contacts: ContactsRepository,
    private readonly settings: SettingsRepository,
    private readonly actions: ActionLogRepository,
    private readonly eventBus: EventBus,
    private readonly now: () => number = Date.now,
  ) {}

  /** Pure: SLA deadline anchored to the relevant message timestamp; null for non-active states. */
  computeSlaDeadline(
    state: ThreadState,
    category: ContactCategory,
    thread: Pick<ThreadRow, 'last_inbound_at' | 'last_outbound_at'>,
  ): number | null {
    if (state === 'awaiting_your_reply') {
      const hours =
        this.settings.get<number>(`agent.sla.${category}.awaiting_your_reply_hours`) ??
        DEFAULT_AWAITING_YOUR_REPLY_HOURS;
      return (thread.last_inbound_at ?? this.now()) + hours * HOUR_MS;
    }
    if (state === 'awaiting_their_reply') {
      const hours =
        this.settings.get<number>('agent.sla.default.awaiting_their_reply_hours') ??
        DEFAULT_AWAITING_THEIR_REPLY_HOURS;
      return (thread.last_outbound_at ?? this.now()) + hours * HOUR_MS;
    }
    return null;
  }

  /** Compute (no write) the transition for a classified inbound message. */
  onInboundClassified(
    thread: ThreadRow,
    result: ClassificationResult,
    message: Pick<MessageRow, 'from_address'>,
  ): ClassifiedTransition {
    const state = nextStateForInbound(thread.state, result.requires_response);
    const category = this.contacts.findByEmail(message.from_address)?.category ?? 'unknown';
    return {
      state,
      urgency: result.urgency,
      slaDeadline: this.computeSlaDeadline(state, category, thread),
    };
  }

  /** Write: an outbound message moves the thread to awaiting_their_reply. */
  onOutbound(threadId: string): void {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    const state = nextStateForOutbound();
    const slaDeadline = this.computeSlaDeadline(state, 'unknown', thread);
    this.threads.setState(threadId, {
      state,
      slaDeadline,
      stateChangedAt: this.now(),
      stateReason: 'outbound_sent',
    });
    this.actions.append({
      actor: 'system',
      action: 'state_outbound',
      targetType: 'thread',
      targetId: threadId,
    });
    this.eventBus.emit({ type: 'thread:updated', payload: { threadId } });
  }

  /** Write: a manual state override from the user. Throws if the thread is missing. */
  onManual(threadId: string, state: ThreadState, reason?: string): void {
    const thread = this.threads.get(threadId);
    if (!thread) throw new NotFoundError('Thread not found');
    const slaDeadline = this.computeSlaDeadline(state, 'unknown', thread);
    this.threads.setState(threadId, {
      state,
      slaDeadline,
      stateChangedAt: this.now(),
      stateReason: reason ?? 'manual_override',
    });
    this.actions.append({
      actor: 'user',
      action: 'state_override',
      targetType: 'thread',
      targetId: threadId,
      details: { state, ...(reason ? { reason } : {}) },
    });
    this.eventBus.emit({ type: 'thread:updated', payload: { threadId } });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @secretary/service test state-machine`
Expected: PASS (transition table + 5 write/SLA cases).

- [ ] **Step 5: Commit**

```bash
git add apps/service/server/agent/StateMachine.ts apps/service/test/state-machine.test.ts
git commit -F - <<'MSG'
feat(service): thread state machine + SLA computation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 8: Classifier system prompt (`classifier.md`)

**Files:**

- Create: `apps/service/server/prompts/classifier.md`

- [ ] **Step 1: Write the prompt**

Create `apps/service/server/prompts/classifier.md`:

```markdown
You are the classification engine for a personal email assistant. You read one inbound email (with brief context about the sender and the recent thread) and decide how the assistant's principal should treat it.

Return a single JSON object with EXACTLY these keys:

- `intent`: one of `inquiry`, `booking_request`, `scheduling`, `chitchat`, `question`, `complaint`, `other`.
- `category_suggestion`: your best guess at the sender's relationship — one of `client_established`, `client_new`, `screening`, `personal`, `vendor`, `noise`, `unknown`. This is advisory only.
- `urgency`: `low`, `normal`, or `high`. Reserve `high` for time-sensitive requests, complaints, or anything a delayed reply would harm.
- `requires_response`: `true` if the principal should personally reply, `false` for FYI/newsletters/automated/acknowledgement-only messages.
- `summary`: at most 140 characters, plain text, describing what the sender wants. No greeting, no quotes.

Rules:

- Judge `requires_response` from the newest message in light of the thread. A "thanks!" closing a resolved exchange does not require a response.
- Marketing, receipts, notifications, and no-reply senders are `requires_response: false` and usually `category_suggestion: noise` or `vendor`.
- Output ONLY the JSON object. No markdown, no code fences, no commentary.
```

- [ ] **Step 2: Verify the file is valid and committed content (no test — it is consumed by Task 9)**

Run: `node -e "const s=require('node:fs').readFileSync('apps/service/server/prompts/classifier.md','utf8'); if(!s.includes('requires_response')) process.exit(1); console.log('ok', s.length)"`
Expected: prints `ok <length>` and exits 0.

- [ ] **Step 3: Ensure the prompt ships with the build (TypeScript does not copy `.md`)**

Check `apps/service/package.json` build script. The server runs from `dist/` in production but `dev:server`/tests run from source via `tsx`/`vitest`, so `PromptAssembler` resolves `classifier.md` relative to its source location at test time. For the production `dist` build, confirm `.md` files under `server/prompts/` are copied. If the build script is `tsc` only, add a copy step. Read the script first; if it is exactly `"build": "tsc"`, change it to:

```json
"build": "tsc && node -e \"require('node:fs').cpSync('server/prompts','dist/prompts',{recursive:true})\"",
```

(If a copy step already exists, leave it.) This task's correctness is verified end-to-end by Task 9's `PromptAssembler` test, which reads the file from source.

- [ ] **Step 4: Commit**

```bash
git add apps/service/server/prompts/classifier.md apps/service/package.json
git commit -F - <<'MSG'
feat(service): classifier system prompt + ship prompts in dist build

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 9: PromptAssembler

**Files:**

- Create: `apps/service/server/agent/PromptAssembler.ts`
- Test: `apps/service/test/prompt-assembler.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/service/test/prompt-assembler.test.ts`:

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
import { ThreadsRepository } from '../server/db/repositories/ThreadsRepository.js';
import { PromptAssembler } from '../server/agent/PromptAssembler.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secretary-pa-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function msg(
  uid: string,
  from: string,
  body: string,
  when: number,
  dir2: 'inbound' | 'outbound' = 'inbound',
): RawMessage {
  return {
    providerId: uid,
    references: [],
    from: { address: from },
    to: [{ address: 'me@b.com' }],
    cc: [],
    bcc: [],
    subject: `Subject ${uid}`,
    bodyText: body,
    snippet: body.slice(0, 200),
    direction: dir2,
    ...(dir2 === 'inbound' ? { dateReceived: when } : { dateSent: when }),
    isRead: false,
    isStarred: false,
    folder: dir2 === 'inbound' ? 'INBOX' : 'Sent',
    labels: [],
    attachmentsMeta: [],
  };
}

describe('PromptAssembler.buildClassificationPrompt', () => {
  it('assembles contact + recent context + the new message, with truncation', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','a@b.com')`,
    ).run();
    const threads = new ThreadsRepository(db);
    const messages = new MessagesRepository(db);
    const contacts = new ContactsRepository(db);
    const threadId = threads.create('acc1', 'subject', ['alice@x.com'], 1000);

    contacts.recordSeen({ address: 'alice@x.com', name: 'Alice' }, 'inbound', 1000);
    contacts.patch(contacts.findByEmail('alice@x.com')!.id, {
      category: 'client_established',
      notes: 'N'.repeat(800),
    });

    // 4 prior messages; only the last 3 should appear, oldest-first.
    messages.insert('acc1', threadId, msg('1', 'alice@x.com', 'oldest', 1000));
    messages.insert('acc1', threadId, msg('2', 'me@b.com', 'reply', 2000, 'outbound'));
    messages.insert('acc1', threadId, msg('3', 'alice@x.com', 'third', 3000));
    messages.insert('acc1', threadId, msg('4', 'me@b.com', 'fourth', 4000, 'outbound'));
    const targetId = messages.insert(
      'acc1',
      threadId,
      msg('5', 'alice@x.com', 'B'.repeat(2500), 5000),
    )!;

    const assembler = new PromptAssembler(messages, threads, contacts);
    const { system, prompt } = assembler.buildClassificationPrompt(targetId);

    expect(system).toContain('requires_response'); // classifier.md loaded
    expect(prompt).toContain('Category: client_established');
    expect(prompt).toContain('N'.repeat(500)); // notes truncated to 500
    expect(prompt).not.toContain('N'.repeat(501));
    expect(prompt).not.toContain('oldest'); // dropped: only last 3 prior
    expect(prompt).toContain('third');
    expect(prompt).toContain('fourth');
    expect(prompt).toContain('…[truncated]'); // body truncated at 2000
    expect(prompt.includes('B'.repeat(2000))).toBe(true);
    expect(prompt.includes('B'.repeat(2001))).toBe(false);
    db.close();
  });

  it('throws NotFoundError for a missing message', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    const assembler = new PromptAssembler(
      new MessagesRepository(db),
      new ThreadsRepository(db),
      new ContactsRepository(db),
    );
    expect(() => assembler.buildClassificationPrompt('nope')).toThrow(/not found/i);
    db.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @secretary/service test prompt-assembler`
Expected: FAIL — cannot find module `PromptAssembler.js`.

- [ ] **Step 3: Implement the PromptAssembler**

Create `apps/service/server/agent/PromptAssembler.ts`:

```typescript
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NotFoundError } from '@secretary/shared-types';
import type { ContactsRepository } from '../db/repositories/ContactsRepository.js';
import type { MessagesRepository } from '../db/repositories/MessagesRepository.js';
import type { ThreadsRepository } from '../db/repositories/ThreadsRepository.js';

const CONTACT_NOTES_MAX = 500;
const SNIPPET_MAX = 200;
const BODY_MAX = 2000;
const CONTEXT_MESSAGES = 3;

const here = dirname(fileURLToPath(import.meta.url));

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…[truncated]`;
}

export class PromptAssembler {
  private classifierSystem: string | null = null;

  constructor(
    private readonly messages: MessagesRepository,
    private readonly threads: ThreadsRepository,
    private readonly contacts: ContactsRepository,
    private readonly promptsDir: string = join(here, '..', 'prompts'),
  ) {}

  private system(): string {
    if (this.classifierSystem === null) {
      this.classifierSystem = readFileSync(join(this.promptsDir, 'classifier.md'), 'utf8');
    }
    return this.classifierSystem;
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
      lines.push('## Recent thread context (oldest first)');
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

    return { system: this.system(), prompt: lines.join('\n') };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @secretary/service test prompt-assembler`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/service/server/agent/PromptAssembler.ts apps/service/test/prompt-assembler.test.ts
git commit -F - <<'MSG'
feat(service): PromptAssembler.buildClassificationPrompt

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 10: Fake gateway helper + Classifier

**Files:**

- Create: `apps/service/test/helpers/fakeGateway.ts`
- Create: `apps/service/server/agent/Classifier.ts`
- Test: `apps/service/test/classifier.test.ts`

- [ ] **Step 1: Write the fake gateway helper**

Create `apps/service/test/helpers/fakeGateway.ts`:

```typescript
import type { CompleteRequest, CompleteResponse } from '@secretary/llm-protocol';
import type { GatewayClient } from '../../server/llm/GatewayClient.js';

/** A GatewayClient that returns scripted `response` strings in order, recording each request. */
export class FakeGateway implements GatewayClient {
  readonly requests: CompleteRequest[] = [];
  private readonly responses: string[];
  private index = 0;

  constructor(responses: string[]) {
    this.responses = responses;
  }

  async complete(req: CompleteRequest): Promise<CompleteResponse> {
    this.requests.push(req);
    const response = this.responses[Math.min(this.index, this.responses.length - 1)] ?? '';
    this.index += 1;
    return { response, model: req.model, tokens_in: 1, tokens_out: 1, duration_ms: 1 };
  }
}

/** A GatewayClient that always throws — for the transport-error path. */
export class ThrowingGateway implements GatewayClient {
  async complete(): Promise<CompleteResponse> {
    throw new Error('gateway down');
  }
}
```

- [ ] **Step 2: Write the failing Classifier test**

Create `apps/service/test/classifier.test.ts`:

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
import { MessagesRepository } from '../server/db/repositories/MessagesRepository.js';
import { SettingsRepository } from '../server/db/repositories/SettingsRepository.js';
import { ThreadsRepository } from '../server/db/repositories/ThreadsRepository.js';
import { EventBus } from '../server/eventBus.js';
import { StateMachine } from '../server/agent/StateMachine.js';
import { PromptAssembler } from '../server/agent/PromptAssembler.js';
import { Classifier } from '../server/agent/Classifier.js';
import { FakeGateway, ThrowingGateway } from './helpers/fakeGateway.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secretary-clf-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const NOOP_LOG = { info() {}, warn() {} };

function inbound(uid: string, body: string, when: number): RawMessage {
  return {
    providerId: uid,
    references: [],
    from: { address: 'alice@x.com', name: 'Alice' },
    to: [{ address: 'me@b.com' }],
    cc: [],
    bcc: [],
    subject: 'Booking?',
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
  threads: ThreadsRepository;
  messages: MessagesRepository;
  actions: ActionLogRepository;
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
  const threadId = threads.create('acc1', 'booking', ['alice@x.com'], 1000);
  contacts.recordSeen({ address: 'alice@x.com', name: 'Alice' }, 'inbound', 1000);
  threads.touch(threadId, { lastInboundAt: 1000, lastMessageAt: 1000 });
  const messageId = messages.insert(
    'acc1',
    threadId,
    inbound('u1', 'Can we book a shoot next week?', 1000),
  )!;
  return { db, threads, messages, actions: new ActionLogRepository(db), threadId, messageId };
}

function makeClassifier(ctx: Ctx, gateway: FakeGateway | ThrowingGateway | null): Classifier {
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
  const prompts = new PromptAssembler(ctx.messages, ctx.threads, contacts);
  return new Classifier(
    prompts,
    gateway,
    stateMachine,
    ctx.threads,
    ctx.messages,
    ctx.actions,
    eventBus,
    settings,
    NOOP_LOG,
    () => 10_000,
  );
}

describe('Classifier.classify', () => {
  it('applies a successful classification to the thread and logs it', async () => {
    const ctx = seed();
    const gw = new FakeGateway([
      '{"intent":"booking_request","category_suggestion":"client_new","urgency":"high","requires_response":true,"summary":"Wants a shoot"}',
    ]);
    await makeClassifier(ctx, gw).classify(ctx.messageId);

    const t = ctx.threads.get(ctx.threadId)!;
    const log = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM action_log WHERE action='classified'")
      .get() as { n: number };
    ctx.db.close();
    expect(t.state).toBe('awaiting_your_reply');
    expect(t.urgency).toBe('high');
    expect(t.last_agent_summary).toBe('Wants a shoot');
    expect(t.sla_deadline).toBe(1000 + 24 * 3_600_000); // unknown category -> 24h fallback
    expect(log.n).toBe(1);
    expect(gw.requests[0]?.format).toBe('json');
  });

  it('retries once on a garbage first response, then succeeds', async () => {
    const ctx = seed();
    const gw = new FakeGateway([
      'I think this is a booking request, probably high urgency.',
      '{"requires_response":true,"urgency":"normal","summary":"ok"}',
    ]);
    await makeClassifier(ctx, gw).classify(ctx.messageId);
    const t = ctx.threads.get(ctx.threadId)!;
    ctx.db.close();
    expect(gw.requests).toHaveLength(2);
    expect(t.state).toBe('awaiting_your_reply');
  });

  it('marks classification_failed and leaves needs_classification after two failures', async () => {
    const ctx = seed();
    const gw = new FakeGateway(['nope', 'still nope']);
    await makeClassifier(ctx, gw).classify(ctx.messageId);
    const t = ctx.threads.get(ctx.threadId)!;
    const log = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM action_log WHERE action='classification_failed'")
      .get() as { n: number };
    ctx.db.close();
    expect(t.state).toBe('needs_classification');
    expect(log.n).toBe(1);
  });

  it('skips entirely when the gateway is not configured (null)', async () => {
    const ctx = seed();
    await makeClassifier(ctx, null).classify(ctx.messageId);
    const t = ctx.threads.get(ctx.threadId)!;
    ctx.db.close();
    expect(t.state).toBe('needs_classification');
  });

  it('treats a thrown gateway error like a failure (no crash)', async () => {
    const ctx = seed();
    await makeClassifier(ctx, new ThrowingGateway()).classify(ctx.messageId);
    const t = ctx.threads.get(ctx.threadId)!;
    const log = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM action_log WHERE action='classification_failed'")
      .get() as { n: number };
    ctx.db.close();
    expect(t.state).toBe('needs_classification');
    expect(log.n).toBe(1);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @secretary/service test classifier`
Expected: FAIL — cannot find module `Classifier.js`.

- [ ] **Step 4: Implement the Classifier**

Create `apps/service/server/agent/Classifier.ts`:

```typescript
import type { ClassificationResult } from '@secretary/shared-types';
import type { GatewayClient } from '../llm/GatewayClient.js';
import type { ActionLogRepository } from '../db/repositories/ActionLogRepository.js';
import type { MessagesRepository } from '../db/repositories/MessagesRepository.js';
import type { SettingsRepository } from '../db/repositories/SettingsRepository.js';
import type { ThreadsRepository } from '../db/repositories/ThreadsRepository.js';
import type { EventBus } from '../eventBus.js';
import type { StateMachine } from './StateMachine.js';
import type { PromptAssembler } from './PromptAssembler.js';
import {
  CLASSIFICATION_JSON_SCHEMA,
  STRICT_JSON_PREAMBLE,
  parseClassification,
} from './classificationSchema.js';

const DEFAULT_MODEL = 'qwen2.5:14b-instruct-q5_K_M';
const DEFAULT_CLASSIFY_TEMPERATURE = 0.1;
const MAX_TOKENS = 300;

/** Minimal logger surface (pino satisfies this structurally). */
export interface MiniLogger {
  info(obj: unknown, msg: string): void;
  warn(obj: unknown, msg: string): void;
}

export class Classifier {
  constructor(
    private readonly prompts: PromptAssembler,
    private readonly gateway: GatewayClient | null,
    private readonly stateMachine: StateMachine,
    private readonly threads: ThreadsRepository,
    private readonly messages: MessagesRepository,
    private readonly actions: ActionLogRepository,
    private readonly eventBus: EventBus,
    private readonly settings: SettingsRepository,
    private readonly log: MiniLogger,
    private readonly now: () => number = Date.now,
  ) {}

  /** Classify one inbound message. Never throws — safe to drive from the queue. */
  async classify(messageId: string): Promise<void> {
    const message = this.messages.getById(messageId);
    if (!message) return;
    const threadId = message.thread_id;

    if (!this.gateway) {
      this.log.warn({ threadId }, 'gateway not configured; leaving thread needs_classification');
      return;
    }

    try {
      const { system, prompt } = this.prompts.buildClassificationPrompt(messageId);
      const model = this.settings.get<string>('llm.model') ?? DEFAULT_MODEL;
      const temperature =
        this.settings.get<number>('llm.temperature.classify') ?? DEFAULT_CLASSIFY_TEMPERATURE;

      let result = await this.attempt(model, system, prompt, temperature);
      if (!result) {
        result = await this.attempt(
          model,
          `${STRICT_JSON_PREAMBLE}\n\n${system}`,
          prompt,
          temperature,
        );
      }
      if (!result) {
        this.markFailed(threadId);
        return;
      }

      const thread = this.threads.get(threadId);
      if (!thread) return;
      const { state, urgency, slaDeadline } = this.stateMachine.onInboundClassified(
        thread,
        result,
        message,
      );
      this.threads.applyClassification(threadId, {
        state,
        urgency,
        summary: result.summary,
        slaDeadline,
        stateChangedAt: this.now(),
        stateReason: 'classified',
      });
      this.actions.append({
        actor: 'agent',
        action: 'classified',
        targetType: 'thread',
        targetId: threadId,
        details: {
          intent: result.intent,
          urgency: result.urgency,
          requires_response: result.requires_response,
          category_suggestion: result.category_suggestion,
        },
      });
      this.eventBus.emit({
        type: 'thread:updated',
        payload: { threadId, accountId: message.account_id },
      });
    } catch (err) {
      this.log.warn(
        { threadId, err: err instanceof Error ? err.message : 'unknown' },
        'classification error',
      );
      this.markFailed(threadId);
    }
  }

  private async attempt(
    model: string,
    system: string,
    prompt: string,
    temperature: number,
  ): Promise<ClassificationResult | null> {
    const res = await this.gateway!.complete({
      model,
      system,
      prompt,
      temperature,
      format: 'json',
      json_schema: CLASSIFICATION_JSON_SCHEMA as Record<string, unknown>,
      max_tokens: MAX_TOKENS,
    });
    return parseClassification(res.response);
  }

  /** Leaves the thread in its current state (needs_classification for a fresh thread) and records the failure. */
  private markFailed(threadId: string): void {
    this.actions.append({
      actor: 'agent',
      action: 'classification_failed',
      targetType: 'thread',
      targetId: threadId,
    });
    this.eventBus.emit({ type: 'thread:updated', payload: { threadId } });
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @secretary/service test classifier`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/service/server/agent/Classifier.ts apps/service/test/classifier.test.ts apps/service/test/helpers/fakeGateway.ts
git commit -F - <<'MSG'
feat(service): Classifier — assemble, complete, validate, retry, apply

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 11: ClassificationQueue

**Files:**

- Create: `apps/service/server/agent/ClassificationQueue.ts`
- Test: `apps/service/test/classification-queue.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/service/test/classification-queue.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { ClassificationQueue } from '../server/agent/ClassificationQueue.js';

/** Records the order classify() is called and proves concurrency is 1. */
class RecordingWorker {
  readonly order: string[] = [];
  private active = 0;
  maxConcurrent = 0;
  async classify(id: string): Promise<void> {
    this.active += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.active);
    await new Promise((r) => setTimeout(r, 1));
    this.order.push(id);
    this.active -= 1;
  }
}

describe('ClassificationQueue', () => {
  it('drains sequentially in FIFO order with concurrency 1', async () => {
    const worker = new RecordingWorker();
    const q = new ClassificationQueue(worker);
    q.enqueue('a');
    q.enqueue('b');
    q.enqueue('c');
    await q.onIdle();
    expect(worker.order).toEqual(['a', 'b', 'c']);
    expect(worker.maxConcurrent).toBe(1);
  });

  it('dedups an id already queued', async () => {
    const worker = new RecordingWorker();
    const q = new ClassificationQueue(worker);
    q.enqueue('a');
    q.enqueue('a');
    await q.onIdle();
    expect(worker.order).toEqual(['a']);
  });

  it('onIdle resolves immediately when nothing is queued', async () => {
    const worker = new RecordingWorker();
    await new ClassificationQueue(worker).onIdle();
    expect(worker.order).toEqual([]);
  });

  it('keeps draining even if a job throws', async () => {
    const order: string[] = [];
    const q = new ClassificationQueue({
      async classify(id: string) {
        if (id === 'bad') throw new Error('boom');
        order.push(id);
      },
    });
    q.enqueue('bad');
    q.enqueue('good');
    await q.onIdle();
    expect(order).toEqual(['good']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @secretary/service test classification-queue`
Expected: FAIL — cannot find module `ClassificationQueue.js`.

- [ ] **Step 3: Implement the queue**

Create `apps/service/server/agent/ClassificationQueue.ts`:

```typescript
export interface ClassificationWorker {
  classify(messageId: string): Promise<void>;
}

/** In-process FIFO queue draining one classification at a time (single GPU friendliness). */
export class ClassificationQueue {
  private readonly order: string[] = [];
  private readonly queued = new Set<string>();
  private draining = false;
  private idleResolvers: Array<() => void> = [];

  constructor(private readonly worker: ClassificationWorker) {}

  enqueue(messageId: string): void {
    if (this.queued.has(messageId)) return;
    this.queued.add(messageId);
    this.order.push(messageId);
    void this.drain();
  }

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
          await this.worker.classify(id);
        } catch {
          /* worker.classify is expected to be self-contained; guard so the loop never stalls */
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

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @secretary/service test classification-queue`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/service/server/agent/ClassificationQueue.ts apps/service/test/classification-queue.test.ts
git commit -F - <<'MSG'
feat(service): in-process sequential ClassificationQueue

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 12: FollowUpEngine

**Files:**

- Create: `apps/service/server/agent/FollowUpEngine.ts`
- Test: `apps/service/test/follow-up-engine.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/service/test/follow-up-engine.test.ts`:

```typescript
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemorySecretStore } from '../server/auth/SecretStore.js';
import { openDatabase } from '../server/db/connection.js';
import { ActionLogRepository } from '../server/db/repositories/ActionLogRepository.js';
import { FollowUpsRepository } from '../server/db/repositories/FollowUpsRepository.js';
import { ThreadsRepository } from '../server/db/repositories/ThreadsRepository.js';
import { EventBus } from '../server/eventBus.js';
import { FollowUpEngine } from '../server/agent/FollowUpEngine.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secretary-fue-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('FollowUpEngine.runOnce', () => {
  it('creates one sla_breach follow-up per breaching thread and is idempotent', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','a@b.com')`,
    ).run();
    const threads = new ThreadsRepository(db);
    const followUps = new FollowUpsRepository(db);
    const events: unknown[] = [];
    const bus = new EventBus();
    bus.subscribe((e) => events.push(e));

    const overdue = threads.create('acc1', 'overdue', [], 1000);
    const future = threads.create('acc1', 'future', [], 1000);
    threads.setState(overdue, {
      state: 'awaiting_your_reply',
      slaDeadline: 500,
      stateChangedAt: 1,
      stateReason: 'x',
    });
    threads.setState(future, {
      state: 'awaiting_your_reply',
      slaDeadline: 50_000,
      stateChangedAt: 1,
      stateReason: 'x',
    });

    const engine = new FollowUpEngine(
      threads,
      followUps,
      new ActionLogRepository(db),
      bus,
      () => 1000,
    );

    expect(engine.runOnce()).toBe(1);
    expect(followUps.listPending().map((f) => f.thread_id)).toEqual([overdue]);
    expect(engine.runOnce()).toBe(0); // suppressed by the existing pending follow-up
    const log = db
      .prepare("SELECT COUNT(*) AS n FROM action_log WHERE action='followup_created'")
      .get() as { n: number };
    db.close();
    expect(log.n).toBe(1);
    expect(events.filter((e) => (e as { type: string }).type === 'thread:updated')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @secretary/service test follow-up-engine`
Expected: FAIL — cannot find module `FollowUpEngine.js`.

- [ ] **Step 3: Implement the engine**

Create `apps/service/server/agent/FollowUpEngine.ts`:

```typescript
import type { ActionLogRepository } from '../db/repositories/ActionLogRepository.js';
import type { FollowUpsRepository } from '../db/repositories/FollowUpsRepository.js';
import type { ThreadsRepository } from '../db/repositories/ThreadsRepository.js';
import type { EventBus } from '../eventBus.js';

const DEFAULT_INTERVAL_MS = 5 * 60_000;

export class FollowUpEngine {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly threads: ThreadsRepository,
    private readonly followUps: FollowUpsRepository,
    private readonly actions: ActionLogRepository,
    private readonly eventBus: EventBus,
    private readonly now: () => number = Date.now,
  ) {}

  /** Scans for SLA breaches and records a follow-up for each (deduped in SQL). Returns count created. */
  runOnce(): number {
    const at = this.now();
    const breaches = this.threads.findSlaBreaches(at);
    let created = 0;
    for (const thread of breaches) {
      this.followUps.insert({
        threadId: thread.id,
        triggerAt: at,
        reason: 'sla_breach',
        createdAt: at,
      });
      this.actions.append({
        actor: 'system',
        action: 'followup_created',
        targetType: 'thread',
        targetId: thread.id,
        details: { reason: 'sla_breach' },
      });
      this.eventBus.emit({ type: 'thread:updated', payload: { threadId: thread.id } });
      created += 1;
    }
    return created;
  }

  start(intervalMs: number = DEFAULT_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.runOnce();
      } catch {
        /* a transient DB error must not kill the interval; it retries next tick */
      }
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @secretary/service test follow-up-engine`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/service/server/agent/FollowUpEngine.ts apps/service/test/follow-up-engine.test.ts
git commit -F - <<'MSG'
feat(service): FollowUpEngine — 5-min SLA-breach detection

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 13: SyncManager integration — sort + per-thread routing + hooks

**Files:**

- Modify: `apps/service/server/sync/SyncManager.ts`
- Test: `apps/service/test/sync-manager.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

Append to `apps/service/test/sync-manager.test.ts` (add an `outbound` helper near the existing `inbound` helper, and a new `describe`):

```typescript
function outbound(uid: string, subject: string, sentMs: number): RawMessage {
  return {
    providerId: uid,
    references: [],
    from: { address: 'me@example.com', name: 'Me' },
    to: [{ address: 'alice@example.com' }],
    cc: [],
    bcc: [],
    subject,
    bodyText: 'reply',
    direction: 'outbound',
    dateSent: sentMs,
    isRead: true,
    isStarred: false,
    folder: 'Sent',
    labels: ['Sent'],
    attachmentsMeta: [],
  };
}

describe('SyncManager post-batch routing', () => {
  function makeHooks() {
    const enqueued: string[] = [];
    const outboundThreads: string[] = [];
    return {
      enqueued,
      outboundThreads,
      hooks: {
        enqueueClassification: (id: string) => enqueued.push(id),
        onOutbound: (threadId: string) => outboundThreads.push(threadId),
      },
    };
  }

  it('enqueues classification when the latest message in a thread is inbound', async () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','Me','me@example.com')`,
    ).run();
    const registry = new ProviderRegistry();
    registry.set(new FakeEmailProvider('acc1', [inbound('1', 'Hello there')]));
    const { enqueued, outboundThreads, hooks } = makeHooks();
    const sync = new SyncManager(db, registry, new EventBus(), Date.now, hooks);

    await sync.initialSync('acc1');

    const latest = db.prepare("SELECT id FROM messages WHERE direction='inbound'").get() as {
      id: string;
    };
    db.close();
    expect(enqueued).toEqual([latest.id]);
    expect(outboundThreads).toEqual([]);
  });

  it('routes a thread whose latest message is outbound to onOutbound (no classify)', async () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','Me','me@example.com')`,
    ).run();
    const registry = new ProviderRegistry();
    // Same thread (shared message-id chain): inbound first, she replied last.
    registry.set(
      new FakeEmailProvider('acc1', [
        inbound('1', 'Project kickoff', undefined, '<m1@x>'),
        outbound('2', 'Re: Project kickoff', 5000),
      ]),
    );
    const { enqueued, outboundThreads, hooks } = makeHooks();
    const sync = new SyncManager(db, registry, new EventBus(), Date.now, hooks);

    await sync.initialSync('acc1');

    const threadId = (db.prepare('SELECT id FROM threads LIMIT 1').get() as { id: string }).id;
    db.close();
    expect(outboundThreads).toEqual([threadId]);
    expect(enqueued).toEqual([]);
  });

  it('does not enqueue when agent.classify_on_inbound is false', async () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','Me','me@example.com')`,
    ).run();
    new SettingsRepository(db).set('agent.classify_on_inbound', false);
    const registry = new ProviderRegistry();
    registry.set(new FakeEmailProvider('acc1', [inbound('1', 'Hello there')]));
    const { enqueued, hooks } = makeHooks();
    const sync = new SyncManager(db, registry, new EventBus(), Date.now, hooks);

    await sync.initialSync('acc1');
    db.close();
    expect(enqueued).toEqual([]);
  });
});
```

Add the imports at the top of the test file (if not present): `import { SettingsRepository } from '../server/db/repositories/SettingsRepository.js';`. The existing `inbound` helper already accepts `(uid, subject, inReplyTo?, messageId?)`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @secretary/service test sync-manager`
Expected: FAIL — `SyncManager` constructor takes no 5th `hooks` argument; routing does not happen, so `enqueued`/`outboundThreads` stay empty.

- [ ] **Step 3: Implement the SyncManager changes**

Edit `apps/service/server/sync/SyncManager.ts`. Add the hooks interface + import `SettingsRepository`, change the constructor, sort the batch, collect touched threads, and route. Full updated file:

```typescript
import type Database from 'better-sqlite3-multiple-ciphers';
import type { RawMessage } from '@secretary/shared-types';
import type { EventBus } from '../eventBus.js';
import type { ProviderRegistry } from '../providers/ProviderRegistry.js';
import { ContactsRepository } from '../db/repositories/ContactsRepository.js';
import { ThreadsRepository } from '../db/repositories/ThreadsRepository.js';
import { MessagesRepository } from '../db/repositories/MessagesRepository.js';
import { ActionLogRepository } from '../db/repositories/ActionLogRepository.js';
import { SettingsRepository } from '../db/repositories/SettingsRepository.js';
import { resolveThreadId, normalizeSubject } from './threading.js';
import { participantsOf } from './normalize.js';

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

/** Side-effects fired after a thread's newest message is persisted. */
export interface SyncHooks {
  enqueueClassification(messageId: string): void;
  onOutbound(threadId: string): void;
}

const NOOP_HOOKS: SyncHooks = {
  enqueueClassification() {},
  onOutbound() {},
};

export class SyncManager {
  private readonly contacts: ContactsRepository;
  private readonly threads: ThreadsRepository;
  private readonly messages: MessagesRepository;
  private readonly actions: ActionLogRepository;
  private readonly settings: SettingsRepository;

  constructor(
    private readonly db: Database.Database,
    private readonly registry: ProviderRegistry,
    private readonly eventBus: EventBus,
    private readonly now: () => number = Date.now,
    private readonly hooks: SyncHooks = NOOP_HOOKS,
  ) {
    this.contacts = new ContactsRepository(db);
    this.threads = new ThreadsRepository(db);
    this.messages = new MessagesRepository(db);
    this.actions = new ActionLogRepository(db);
    this.settings = new SettingsRepository(db);
  }

  async initialSync(accountId: string): Promise<void> {
    const provider = this.registry.get(accountId);
    if (!provider) return;
    try {
      await provider.connect();
      const msgs = await provider.syncFull(this.now() - NINETY_DAYS_MS);
      const changed = this.persistBatch(accountId, msgs);
      this.markSynced(accountId);
      if (changed) this.eventBus.emit({ type: 'thread:updated', payload: { accountId } });
      await provider.startWatching(() => {
        void this.incrementalSync(accountId);
      });
    } catch (err) {
      console.error(
        `[secretary] initial sync failed (${accountId}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  async incrementalSync(accountId: string): Promise<void> {
    const provider = this.registry.get(accountId);
    if (!provider) return;
    try {
      const { newMessages } = await provider.syncIncremental();
      const changed = this.persistBatch(accountId, newMessages);
      this.markSynced(accountId);
      if (changed) this.eventBus.emit({ type: 'thread:updated', payload: { accountId } });
    } catch (err) {
      console.error(
        `[secretary] incremental sync failed (${accountId}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Persists a batch best-effort (a poison message is logged and skipped), in
   * chronological order so thread aggregates settle correctly, then routes each
   * touched thread by its newest message to the right side-effect.
   */
  private persistBatch(accountId: string, msgs: RawMessage[]): boolean {
    const sorted = [...msgs].sort(
      (a, b) => (a.dateReceived ?? a.dateSent ?? 0) - (b.dateReceived ?? b.dateSent ?? 0),
    );
    const touched = new Set<string>();
    let any = false;
    for (const raw of sorted) {
      try {
        const threadId = this.persist(accountId, raw);
        if (threadId) {
          any = true;
          touched.add(threadId);
        }
      } catch {
        try {
          this.actions.append({
            actor: 'system',
            action: 'message_sync_failed',
            targetType: 'message',
            targetId: raw.providerId,
          });
        } catch {
          /* audit append is best-effort */
        }
      }
    }
    for (const threadId of touched) this.route(threadId);
    return any;
  }

  /** Routes the thread by its newest message: outbound -> state change; inbound -> classify. */
  private route(threadId: string): void {
    const latest = this.messages.latestForThread(threadId);
    if (!latest) return;
    if (latest.direction === 'outbound') {
      this.hooks.onOutbound(threadId);
      return;
    }
    if (this.settings.get<boolean>('agent.classify_on_inbound') !== false) {
      this.hooks.enqueueClassification(latest.id);
    }
  }

  /**
   * Persists one new message in a transaction. Skips entirely if it already
   * exists. Returns the thread id it was persisted into, or null if nothing changed.
   */
  private persist(accountId: string, raw: RawMessage): string | null {
    const when = raw.dateReceived ?? raw.dateSent ?? this.now();
    let result: string | null = null;
    const tx = this.db.transaction(() => {
      if (this.messages.existsByProviderId(accountId, raw.providerId)) return;
      this.contacts.recordSeen(raw.from, raw.direction, when);
      const candidate = {
        references: raw.references,
        ...(raw.inReplyTo ? { inReplyTo: raw.inReplyTo } : {}),
        ...(raw.subject ? { subject: raw.subject } : {}),
      };
      const threadId =
        resolveThreadId(candidate, {
          threadIdForMessageIds: (ids) => this.threads.threadIdForMessageIds(accountId, ids),
          threadIdForSubject: (s) => this.threads.threadIdForSubject(accountId, s),
        }) ??
        this.threads.create(accountId, normalizeSubject(raw.subject), participantsOf(raw), when);
      this.messages.insert(accountId, threadId, raw);
      this.threads.touch(threadId, {
        lastMessageAt: when,
        ...(raw.direction === 'inbound' ? { lastInboundAt: when } : { lastOutboundAt: when }),
      });
      this.actions.append({
        actor: 'system',
        action: 'message_synced',
        targetType: 'message',
        targetId: raw.providerId,
        details: { direction: raw.direction, folder: raw.folder },
      });
      result = threadId;
    });
    tx();
    return result;
  }

  private markSynced(accountId: string): void {
    this.db
      .prepare("UPDATE accounts SET last_synced_at = ?, sync_state = 'idle' WHERE id = ?")
      .run(this.now(), accountId);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass (new + existing)**

Run: `pnpm --filter @secretary/service test sync-manager`
Expected: PASS — the original 3 tests (which construct `SyncManager` without hooks → `NOOP_HOOKS`) plus the 3 new routing tests.

- [ ] **Step 5: Commit**

```bash
git add apps/service/server/sync/SyncManager.ts apps/service/test/sync-manager.test.ts
git commit -F - <<'MSG'
feat(service): SyncManager routes each thread's latest message to classify/state

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 14: threads API — needs-attention, state override, classify

**Files:**

- Modify: `apps/service/server/server.ts` (ServerDeps)
- Modify: `apps/service/server/api/threads.ts`
- Modify: `apps/service/test/helpers/testServer.ts`
- Test: `apps/service/test/threads-routes.test.ts` (extend)

- [ ] **Step 1: Extend ServerDeps and the test helper**

In `apps/service/server/server.ts`, add to the imports:

```typescript
import type { ThreadState } from '@secretary/shared-types';
```

Add these two fields to the `ServerDeps` interface (after `providerFactory`):

```typescript
  /** Enqueue a message id for asynchronous classification. */
  classificationQueue: { enqueue(messageId: string): void };
  /** Apply manual thread state overrides. */
  stateMachine: { onManual(threadId: string, state: ThreadState, reason?: string): void };
```

In `apps/service/test/helpers/testServer.ts`, construct a capturing queue + a real `StateMachine` and pass them. Add imports:

```typescript
import { StateMachine } from '../../server/agent/StateMachine.js';
import { ThreadsRepository } from '../../server/db/repositories/ThreadsRepository.js';
import { ContactsRepository } from '../../server/db/repositories/ContactsRepository.js';
import { SettingsRepository } from '../../server/db/repositories/SettingsRepository.js';
import { ActionLogRepository } from '../../server/db/repositories/ActionLogRepository.js';
```

Add a `classificationQueue` field to the `TestServer` interface:

```typescript
  classificationQueue: { enqueued: string[]; enqueue(messageId: string): void };
  stateMachine: StateMachine;
```

In `makeTestServer`, before `buildServer(...)`:

```typescript
const enqueued: string[] = [];
const classificationQueue = {
  enqueued,
  enqueue(messageId: string) {
    enqueued.push(messageId);
  },
};
const stateMachine = new StateMachine(
  new ThreadsRepository(db),
  new ContactsRepository(db),
  new SettingsRepository(db),
  new ActionLogRepository(db),
  eventBus,
);
```

Add `classificationQueue` and `stateMachine` to the `buildServer({ … })` deps object, and to the returned object.

- [ ] **Step 2: Write the failing route tests**

Append to `apps/service/test/threads-routes.test.ts`:

```typescript
describe('threads attention/state/classify routes', () => {
  it('needs-attention returns awaiting_your_reply ordered, with follow-up flag', async () => {
    const { app, session, db } = await makeTestServer();
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','a@b.com')`,
    ).run();
    db.prepare(
      `INSERT INTO threads (id, account_id, subject_normalized, participants, message_count, last_message_at, state, urgency, sla_deadline, last_agent_summary)
       VALUES ('hi','acc1','urgent','[]',1,1000,'awaiting_your_reply','high',5000,'Reply needed')`,
    ).run();
    db.prepare(
      `INSERT INTO threads (id, account_id, subject_normalized, participants, message_count, last_message_at, state, urgency, sla_deadline)
       VALUES ('lo','acc1','later','[]',1,1000,'awaiting_your_reply','normal',9000)`,
    ).run();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/threads/needs-attention',
      headers: { authorization: `Bearer ${session}` },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.map((t: { id: string }) => t.id)).toEqual(['hi', 'lo']);
    expect(data[0].urgency).toBe('high');
    expect(data[0].summary).toBe('Reply needed');
    expect(data[0].slaDeadline).toBe(new Date(5000).toISOString());
    expect(data[0].hasPendingFollowUp).toBe(false);
    await app.close();
  });

  it('POST /threads/:id/state applies a manual override', async () => {
    const { app, session, db } = await makeTestServer();
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','a@b.com')`,
    ).run();
    db.prepare(
      `INSERT INTO threads (id, account_id, subject_normalized, participants, message_count, last_message_at, state)
       VALUES ('t1','acc1','x','[]',1,1000,'awaiting_your_reply')`,
    ).run();

    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/threads/t1/state',
      headers: { authorization: `Bearer ${session}` },
      payload: { state: 'closed', reason: 'handled offline' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.state).toBe('closed');

    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/threads/t1/state',
      headers: { authorization: `Bearer ${session}` },
      payload: { state: 'not_a_state' },
    });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it('POST /threads/:id/classify enqueues the latest inbound; 400 when none', async () => {
    const { app, session, db, classificationQueue } = await makeTestServer();
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','a@b.com')`,
    ).run();
    db.prepare(
      `INSERT INTO threads (id, account_id, subject_normalized, participants, message_count, last_message_at, state)
       VALUES ('t1','acc1','x','[]',1,1000,'needs_classification')`,
    ).run();
    db.prepare(
      `INSERT INTO messages (id, account_id, provider_id, thread_id, from_address, direction, date_received)
       VALUES ('m1','acc1','u1','t1','a@b.com','inbound',1000)`,
    ).run();

    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/threads/t1/classify',
      headers: { authorization: `Bearer ${session}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.queued).toBe(true);
    expect(classificationQueue.enqueued).toEqual(['m1']);

    db.prepare(
      `INSERT INTO threads (id, account_id, subject_normalized, participants, message_count, last_message_at, state)
       VALUES ('t2','acc1','y','[]',0,1000,'needs_classification')`,
    ).run();
    const none = await app.inject({
      method: 'POST',
      url: '/api/v1/threads/t2/classify',
      headers: { authorization: `Bearer ${session}` },
    });
    expect(none.statusCode).toBe(400);
    await app.close();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @secretary/service test threads-routes`
Expected: FAIL — routes 404 (not registered) and `classificationQueue` is undefined on the test server.

- [ ] **Step 4: Implement the routes**

Replace `apps/service/server/api/threads.ts` with the extended version (keeps the existing list/detail, adds the three routes + the `NeedsAttentionItem` mapper + a zod body schema). The full file:

```typescript
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3-multiple-ciphers';
import { z } from 'zod';
import {
  NotFoundError,
  ValidationError,
  type EmailAddress,
  type MessageView,
  type NeedsAttentionItem,
  type ThreadState,
  type ThreadSummary,
  type ThreadWithMessages,
} from '@secretary/shared-types';
import { ThreadsRepository, type AttentionRow } from '../db/repositories/ThreadsRepository.js';
import { MessagesRepository } from '../db/repositories/MessagesRepository.js';
import type { MessageRow, ThreadRow } from '../db/schema.js';

const stateBodySchema = z.object({
  state: z.enum([
    'needs_classification',
    'awaiting_their_reply',
    'awaiting_your_reply',
    'closed',
    'scheduled_followup',
    'informational',
  ]),
  reason: z.string().optional(),
});

function parseAddrs(json: string | null): EmailAddress[] {
  if (!json) return [];
  try {
    return JSON.parse(json) as EmailAddress[];
  } catch {
    return [];
  }
}

function threadSummary(row: ThreadRow): ThreadSummary {
  return {
    id: row.id,
    accountId: row.account_id,
    subject: row.subject_normalized,
    participants: row.participants ? (JSON.parse(row.participants) as string[]) : [],
    messageCount: row.message_count,
    lastMessageAt: row.last_message_at ? new Date(row.last_message_at).toISOString() : null,
    state: row.state,
  };
}

function needsAttentionItem(row: AttentionRow): NeedsAttentionItem {
  return {
    ...threadSummary(row),
    urgency: row.urgency,
    slaDeadline: row.sla_deadline ? new Date(row.sla_deadline).toISOString() : null,
    summary: row.last_agent_summary,
    hasPendingFollowUp: row.has_pending === 1,
  };
}

function messageView(row: MessageRow): MessageView {
  return {
    id: row.id,
    from: row.from_name
      ? { address: row.from_address, name: row.from_name }
      : { address: row.from_address },
    to: parseAddrs(row.to_addresses),
    subject: row.subject,
    snippet: row.snippet,
    bodyText: row.body_text,
    direction: row.direction,
    dateReceived: row.date_received ? new Date(row.date_received).toISOString() : null,
    isRead: row.is_read === 1,
  };
}

export interface ThreadsRouteDeps {
  db: Database.Database;
  classificationQueue: { enqueue(messageId: string): void };
  stateMachine: { onManual(threadId: string, state: ThreadState, reason?: string): void };
}

export function registerThreadsRoutes(app: FastifyInstance, deps: ThreadsRouteDeps): void {
  const threads = new ThreadsRepository(deps.db);
  const messages = new MessagesRepository(deps.db);

  app.get('/threads/needs-attention', async () => ({
    data: threads.needsAttention().map(needsAttentionItem),
  }));

  app.get('/threads', async (req) => {
    const q = req.query as { accountId?: string; limit?: string; offset?: string };
    const limit = Math.min(Number(q.limit ?? '50'), 200);
    const offset = Number(q.offset ?? '0');
    const rows = q.accountId
      ? threads.listByAccount(q.accountId, limit, offset)
      : (deps.db
          .prepare('SELECT * FROM threads ORDER BY last_message_at DESC LIMIT ? OFFSET ?')
          .all(limit, offset) as ThreadRow[]);
    return { data: rows.map(threadSummary) };
  });

  app.get('/threads/:id', async (req) => {
    const { id } = req.params as { id: string };
    const row = threads.get(id);
    if (!row) throw new NotFoundError('Thread not found');
    const view: ThreadWithMessages = {
      ...threadSummary(row),
      messages: messages.listByThread(id).map(messageView),
    };
    return { data: view };
  });

  app.post('/threads/:id/state', async (req) => {
    const { id } = req.params as { id: string };
    const parsed = stateBodySchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid state');
    if (!threads.get(id)) throw new NotFoundError('Thread not found');
    deps.stateMachine.onManual(id, parsed.data.state, parsed.data.reason);
    const updated = threads.get(id);
    if (!updated) throw new NotFoundError('Thread not found');
    return { data: threadSummary(updated) };
  });

  app.post('/threads/:id/classify', async (req) => {
    const { id } = req.params as { id: string };
    if (!threads.get(id)) throw new NotFoundError('Thread not found');
    const latest = messages.latestInboundForThread(id);
    if (!latest) throw new ValidationError('No inbound message to classify');
    deps.classificationQueue.enqueue(latest.id);
    return { data: { queued: true } };
  });
}
```

`buildServer` already calls `registerThreadsRoutes(api, deps)`; since `deps` is `ServerDeps` (now including `classificationQueue` + `stateMachine`), it satisfies `ThreadsRouteDeps` structurally. No change to the call site is required.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @secretary/service test threads-routes`
Expected: PASS (original 2 + 3 new).

- [ ] **Step 6: Commit**

```bash
git add apps/service/server/server.ts apps/service/server/api/threads.ts apps/service/test/helpers/testServer.ts apps/service/test/threads-routes.test.ts
git commit -F - <<'MSG'
feat(service): needs-attention, manual state, and re-classify routes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 15: contacts API

**Files:**

- Create: `apps/service/server/api/contacts.ts`
- Modify: `apps/service/server/server.ts` (register the routes)
- Test: `apps/service/test/contacts-routes.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/service/test/contacts-routes.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { makeTestServer } from './helpers/testServer.js';

describe('contacts routes', () => {
  it('lists, gets, and patches a contact (category override is recorded)', async () => {
    const { app, session, db } = await makeTestServer();
    db.prepare(
      `INSERT INTO contacts (id, email_address, display_name, category, total_messages_in, total_messages_out, do_not_auto_draft, last_contact_at)
       VALUES ('c1','alice@x.com','Alice','unknown',3,1,0,2000)`,
    ).run();

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/contacts',
      headers: { authorization: `Bearer ${session}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data[0].emailAddress).toBe('alice@x.com');
    expect(list.json().data[0].lastContactAt).toBe(new Date(2000).toISOString());

    const get = await app.inject({
      method: 'GET',
      url: '/api/v1/contacts/c1',
      headers: { authorization: `Bearer ${session}` },
    });
    expect(get.json().data.category).toBe('unknown');

    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/v1/contacts/c1',
      headers: { authorization: `Bearer ${session}` },
      payload: { category: 'client_established', notes: 'VIP' },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().data.category).toBe('client_established');

    const log = db
      .prepare("SELECT COUNT(*) AS n FROM action_log WHERE action='contact_updated'")
      .get() as { n: number };
    expect(log.n).toBe(1);

    const bad = await app.inject({
      method: 'PATCH',
      url: '/api/v1/contacts/c1',
      headers: { authorization: `Bearer ${session}` },
      payload: { category: 'bogus' },
    });
    expect(bad.statusCode).toBe(400);

    const missing = await app.inject({
      method: 'GET',
      url: '/api/v1/contacts/nope',
      headers: { authorization: `Bearer ${session}` },
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @secretary/service test contacts-routes`
Expected: FAIL — `/api/v1/contacts` 404 (routes not registered).

- [ ] **Step 3: Implement the contacts routes**

Create `apps/service/server/api/contacts.ts`:

```typescript
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3-multiple-ciphers';
import { z } from 'zod';
import { NotFoundError, ValidationError, type ContactView } from '@secretary/shared-types';
import { ContactsRepository } from '../db/repositories/ContactsRepository.js';
import { ActionLogRepository } from '../db/repositories/ActionLogRepository.js';
import type { ContactRow } from '../db/schema.js';

const CONTACT_CATEGORIES = [
  'client_established',
  'client_new',
  'screening',
  'personal',
  'vendor',
  'noise',
  'unknown',
] as const;

const patchSchema = z
  .object({
    category: z.enum(CONTACT_CATEGORIES).optional(),
    notes: z.string().optional(),
    styleNotes: z.unknown().optional(),
    doNotAutoDraft: z.boolean().optional(),
  })
  .strict();

function contactView(row: ContactRow): ContactView {
  return {
    id: row.id,
    emailAddress: row.email_address,
    displayName: row.display_name,
    category: row.category,
    notes: row.notes,
    doNotAutoDraft: row.do_not_auto_draft === 1,
    totalMessagesIn: row.total_messages_in,
    totalMessagesOut: row.total_messages_out,
    lastContactAt: row.last_contact_at ? new Date(row.last_contact_at).toISOString() : null,
  };
}

export function registerContactsRoutes(
  app: FastifyInstance,
  deps: { db: Database.Database },
): void {
  const contacts = new ContactsRepository(deps.db);
  const actions = new ActionLogRepository(deps.db);

  app.get('/contacts', async (req) => {
    const q = req.query as { category?: string; limit?: string; offset?: string };
    const limit = Math.min(Number(q.limit ?? '50'), 200);
    const offset = Number(q.offset ?? '0');
    const isCategory = (v: string | undefined): v is (typeof CONTACT_CATEGORIES)[number] =>
      v !== undefined && (CONTACT_CATEGORIES as readonly string[]).includes(v);
    const rows = contacts.list({
      ...(isCategory(q.category) ? { category: q.category } : {}),
      limit,
      offset,
    });
    return { data: rows.map(contactView) };
  });

  app.get('/contacts/:id', async (req) => {
    const { id } = req.params as { id: string };
    const row = contacts.getById(id);
    if (!row) throw new NotFoundError('Contact not found');
    return { data: contactView(row) };
  });

  app.patch('/contacts/:id', async (req) => {
    const { id } = req.params as { id: string };
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid contact patch');
    if (!contacts.getById(id)) throw new NotFoundError('Contact not found');
    const updated = contacts.patch(id, parsed.data);
    if (!updated) throw new NotFoundError('Contact not found');
    actions.append({
      actor: 'user',
      action: 'contact_updated',
      targetType: 'contact',
      targetId: id,
      details: { fields: Object.keys(parsed.data) },
    });
    return { data: contactView(updated) };
  });
}
```

- [ ] **Step 4: Register the routes**

In `apps/service/server/server.ts`, add the import near the other route imports:

```typescript
import { registerContactsRoutes } from './api/contacts.js';
```

And register it inside the `/api/v1` plugin block, after `registerThreadsRoutes(api, deps);`:

```typescript
registerContactsRoutes(api, deps);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @secretary/service test contacts-routes`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/service/server/api/contacts.ts apps/service/server/server.ts apps/service/test/contacts-routes.test.ts
git commit -F - <<'MSG'
feat(service): contacts API (list/get/patch) with category override audit

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 16: Compose the agent layer in `index.ts`

**Files:**

- Modify: `apps/service/server/index.ts`

This is the composition root: build the gateway (if configured), the agent objects, wire the queue + state machine into `SyncManager` and `buildServer`, start the follow-up engine, and recover unclassified threads on boot. There is no unit test for the composition root (it does network/keychain/timers); it is verified by `typecheck`, the existing `smoke.test.ts`, and manual verification (Task 18).

- [ ] **Step 1: Implement the wiring**

Edit `apps/service/server/index.ts`. Add imports:

```typescript
import { createGatewayClient, type GatewayClient } from './llm/GatewayClient.js';
import { ThreadsRepository } from './db/repositories/ThreadsRepository.js';
import { MessagesRepository } from './db/repositories/MessagesRepository.js';
import { ContactsRepository } from './db/repositories/ContactsRepository.js';
import { SettingsRepository } from './db/repositories/SettingsRepository.js';
import { ActionLogRepository } from './db/repositories/ActionLogRepository.js';
import { FollowUpsRepository } from './db/repositories/FollowUpsRepository.js';
import { StateMachine } from './agent/StateMachine.js';
import { PromptAssembler } from './agent/PromptAssembler.js';
import { Classifier } from './agent/Classifier.js';
import { ClassificationQueue } from './agent/ClassificationQueue.js';
import { FollowUpEngine } from './agent/FollowUpEngine.js';
```

Replace the section between the `eventBus` creation and the `buildServer(...)` call. After `const eventBus = new EventBus();` and the bootstrap-token write, build the agent layer (note: `providers`, `sync` must now be built with the hooks; move their construction here):

```typescript
// --- Agent layer (Phase 4) ---
const settingsRepo = new SettingsRepository(db);
const threadsRepo = new ThreadsRepository(db);
const messagesRepo = new MessagesRepository(db);
const contactsRepo = new ContactsRepository(db);
const actionsRepo = new ActionLogRepository(db);
const followUpsRepo = new FollowUpsRepository(db);

// Build the gateway client only if its credentials exist in the keychain;
// otherwise classification is disabled (threads stay needs_classification).
let gateway: GatewayClient | null = null;
const gwApiKey = store.get('app.gateway-api-key');
const gwPayloadKey = store.get('app.payload-key');
if (gwApiKey && gwPayloadKey) {
  gateway = createGatewayClient({
    gatewayUrl: config.gatewayUrl,
    useCfHeaders: config.gatewayUseCfHeaders,
    apiKey: gwApiKey,
    payloadKey: gwPayloadKey,
    ...(config.gatewayUseCfHeaders
      ? {
          cfClientId: store.get('app.cf-access-id') ?? '',
          cfClientSecret: store.get('app.cf-access-secret') ?? '',
        }
      : {}),
  });
} else {
  log.warn('gateway credentials missing; classification disabled until setup completes');
}

const stateMachine = new StateMachine(
  threadsRepo,
  contactsRepo,
  settingsRepo,
  actionsRepo,
  eventBus,
);
const promptAssembler = new PromptAssembler(messagesRepo, threadsRepo, contactsRepo);
const classifier = new Classifier(
  promptAssembler,
  gateway,
  stateMachine,
  threadsRepo,
  messagesRepo,
  actionsRepo,
  eventBus,
  settingsRepo,
  log,
);
const classificationQueue = new ClassificationQueue(classifier);
const followUpEngine = new FollowUpEngine(threadsRepo, followUpsRepo, actionsRepo, eventBus);

const providers = new ProviderRegistry();
const sync = new SyncManager(db, providers, eventBus, Date.now, {
  enqueueClassification: (messageId) => classificationQueue.enqueue(messageId),
  onOutbound: (threadId) => stateMachine.onOutbound(threadId),
});
const providerFactory = (cfg: ImapConfig) => new ImapProvider(cfg);
```

(Delete the original `const providers = …`, `const sync = …`, and `const providerFactory = …` lines that were here so they are not declared twice.)

Add `classificationQueue` and `stateMachine` to the `buildServer({ … })` deps object:

```typescript
const app = buildServer({
  db,
  sessions,
  eventBus,
  origin: `https://localhost:${config.port}`,
  https,
  pwaDir: join(here, '..', 'pwa'),
  secrets: store,
  providers,
  sync,
  providerFactory,
  classificationQueue,
  stateMachine,
});
```

After the account-resume loop (after the `for (const acc of enabled) { … }` block), start the follow-up engine and recover unclassified threads:

```typescript
// Start the SLA follow-up engine (5-minute cron).
followUpEngine.start();

// Recovery: re-enqueue classification for any thread left needs_classification
// (e.g. created before a previous crash, or while the gateway was unconfigured).
for (const thread of threadsRepo.findNeedsClassification()) {
  const latest = messagesRepo.latestInboundForThread(thread.id);
  if (latest) classificationQueue.enqueue(latest.id);
}
```

In the graceful-shutdown handler, stop the engine before closing the server. Change the shutdown body to:

```typescript
log.info({ sig }, 'shutting down');
followUpEngine.stop();
void app
  .close()
  .catch(() => undefined)
  .then(() => {
    db.close();
    process.exit(0);
  });
```

- [ ] **Step 2: Typecheck the service**

Run: `pnpm --filter @secretary/service typecheck`
Expected: exits 0 (no duplicate declarations, all deps satisfied).

- [ ] **Step 3: Run the full service suite (confirms smoke + everything still green)**

Run: `pnpm --filter @secretary/service test`
Expected: all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/service/server/index.ts
git commit -F - <<'MSG'
feat(service): wire classifier, queue, state machine, follow-up engine in index

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 17: Update BRIEF.md with the Phase 4 deviations

**Files:**

- Modify: `BRIEF.md`

Per BRIEF §18, record the implementation decisions that extend/deviate from the literal brief.

- [ ] **Step 1: Add a note to §11 (classification job)**

In `BRIEF.md`, at the end of the "Classification job" subsection of §11 (right before "### State transition rules (§11.1)"), add:

```markdown
**Phase 4 implementation notes (refinements to the above):**

- Classification is keyed **per thread, by the thread's latest message**, not per inbound message. After a sync batch, each touched thread is routed once by its newest message: an outbound message applies the deterministic outbound transition; an inbound message is enqueued for classification. This avoids superseded/out-of-order transitions on the initial backlog and removes the race between a synchronous outbound transition and an asynchronous inbound classification.
- Classification runs in an **in-process, sequential queue** (one LLM call at a time). The durable recovery marker is the thread's `needs_classification` state: on startup, every such thread's latest inbound message is re-enqueued.
- `category_suggestion` is **advisory only** — it is recorded in `action_log` but never auto-applied to a contact's `category` (which drives SLA). Category changes are manual (contacts `PATCH`).
- If gateway credentials are not yet configured, classification is skipped and threads remain `needs_classification`.
```

- [ ] **Step 2: Add a note to §11.1 (state transitions + SLA)**

Immediately after the state-transition table in §11.1, add:

```markdown
**SLA anchoring + the `needs_classification` start state (Phase 4):**

- The SLA deadline is anchored to the relevant message timestamp, not "now": `awaiting_your_reply` → `last_inbound_at + slaHours`; `awaiting_their_reply` → `last_outbound_at + 72h`. Overdue backlog threads therefore surface immediately (and may generate many `sla_breach` follow-ups on the first sync — expected).
- `slaHours` for `awaiting_your_reply` is `agent.sla.<category>.awaiting_your_reply_hours` (client_established=12, client_new=4), with a **24h fallback** for any other category or missing key.
- Transitions from the initial `needs_classification` state: inbound `requires_response=true` → `awaiting_your_reply`; inbound `requires_response=false` → `informational`.
```

- [ ] **Step 3: Add a note to §14 Phase 4**

At the end of the "### Phase 4" subsection (after its Acceptance list), add:

```markdown
**Scope note:** Phase 4 ships the classification/state/follow-up engine and its API (`/threads/needs-attention`, `/threads/:id/state`, `/threads/:id/classify`, contacts `GET`/`PATCH`). Item 5 (the PWA "Needs Attention" view) is deferred to when the PWA is built (Phase 2.5), since no React PWA exists yet. The follow-up engine creates `follow_ups` rows + emits SSE; Web Push delivery on breach is Phase 5.5. The `GET/POST /followups` HTTP endpoints (§9) are deferred (not required by Phase 4 acceptance).
```

- [ ] **Step 4: Commit**

```bash
git add BRIEF.md
git commit -F - <<'MSG'
docs(brief): record Phase 4 classification/SLA implementation decisions

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 18: Manual verification runbook

**Files:**

- Create: `docs/PHASE-4-MANUAL-VERIFICATION.md`

- [ ] **Step 1: Write the runbook**

Create `docs/PHASE-4-MANUAL-VERIFICATION.md`:

````markdown
# Phase 4 — Manual Verification (Classification + State Machine + Follow-ups)

The automated suite covers the agent logic (state machine, SLA, classifier with a fake gateway,
queue, follow-up engine) and the routes. This runbook verifies real LLM classification end-to-end
against the operator's Ollama. All commands are PowerShell from the repo root
`C:\Users\drice\Secretary`. Prerequisites are the same as Phase 3 (Node-ABI SQLite, HTTPS certs,
the Gmail test account already added).

## 0. Point the gateway at a real model

Classification calls the gateway, which forwards to Ollama. Set the classifier model to the model
you actually have pulled (the seeded default is `qwen2.5:14b-instruct-q5_K_M`; a small model like
`qwen2.5:1.5b` proves the pipeline, with rougher quality). Gateway credentials must be in the
keychain (from Phase 2 setup); if they are absent, classification is skipped and threads stay
`needs_classification`.

## 1. Start the service + get a session token

```powershell
$env:LOG_PRETTY = 'true'
pnpm --filter @secretary/service dev:server
```

In a second terminal:

```powershell
$BOOT = (Get-Content "$env:USERPROFILE\.secretary\bootstrap-token.txt" -Raw).Trim()
$T = (Invoke-RestMethod -Method Post -Uri https://localhost:47824/api/v1/auth/session `
  -ContentType 'application/json' -Body (@{ bootstrapToken = $BOOT } | ConvertTo-Json)).data.token
```

Set the classifier model (use your pulled model):

```powershell
Invoke-RestMethod -Method Patch -Uri https://localhost:47824/api/v1/settings `
  -Headers @{ authorization = "Bearer $T" } -ContentType 'application/json' `
  -Body (@{ 'llm.model' = 'qwen2.5:1.5b' } | ConvertTo-Json)
```

## 2. Trigger classification

Re-sync the Gmail account so the backlog routes through classification (or send yourself a new
email and wait for the IDLE watcher):

```powershell
$ACC = (Invoke-RestMethod -Uri https://localhost:47824/api/v1/accounts -Headers @{ authorization = "Bearer $T" }).data[0].id
Invoke-RestMethod -Method Post -Uri "https://localhost:47824/api/v1/accounts/$ACC/resync" -Headers @{ authorization = "Bearer $T" }
```

Watch the service log: you should see classification activity. Because the queue is sequential and
the model unloads between calls (`keep_alive: 0`), a large backlog drains slowly — that's expected.

## 3. Verify Needs Attention

```powershell
(Invoke-RestMethod -Uri https://localhost:47824/api/v1/threads/needs-attention -Headers @{ authorization = "Bearer $T" }).data |
  Format-Table id, state, urgency, slaDeadline, summary, hasPendingFollowUp
```

Expect threads that need a reply, ordered by urgency (high first) then SLA (soonest first), each with
an agent `summary`. Threads where you sent the last message should NOT appear (they are
`awaiting_their_reply`).

## 4. Verify a single thread's classification

```powershell
$TH = (Invoke-RestMethod -Uri https://localhost:47824/api/v1/threads/needs-attention -Headers @{ authorization = "Bearer $T" }).data[0].id
(Invoke-RestMethod -Uri "https://localhost:47824/api/v1/threads/$TH" -Headers @{ authorization = "Bearer $T" }).data | Format-List state, subject
# Re-classify on demand:
Invoke-RestMethod -Method Post -Uri "https://localhost:47824/api/v1/threads/$TH/classify" -Headers @{ authorization = "Bearer $T" }
```

## 5. Verify SLA follow-ups

Overdue backlog threads (deadline in the past) should produce `follow_ups` within 5 minutes (the
engine tick). Confirm via the action log / DB, or simply re-check `needs-attention` after a few
minutes — newly-breached threads gain `hasPendingFollowUp: true`.

## 6. Verify the contact category override

```powershell
$C = (Invoke-RestMethod -Uri https://localhost:47824/api/v1/contacts -Headers @{ authorization = "Bearer $T" }).data[0].id
Invoke-RestMethod -Method Patch -Uri "https://localhost:47824/api/v1/contacts/$C" `
  -Headers @{ authorization = "Bearer $T" } -ContentType 'application/json' `
  -Body (@{ category = 'client_new' } | ConvertTo-Json)
```

A subsequent inbound from that contact (or a manual re-classify that lands `awaiting_your_reply`)
should use the tighter `client_new` 4-hour SLA on its next transition.

## Acceptance (BRIEF §14 Phase 4)

- Inbound messages get classified within seconds of sync (step 2–3). ✅
- Threads requiring a response surface in Needs Attention, urgency + SLA ordered (step 3). ✅
- SLA breaches generate follow-ups within 5 minutes (step 5). ✅
- Action log captures every classification (`action='classified'`). ✅ (automated + DB check)
- Manual category override updates future SLAs (step 6). ✅
````

- [ ] **Step 2: Commit**

```bash
git add docs/PHASE-4-MANUAL-VERIFICATION.md
git commit -F - <<'MSG'
docs: Phase 4 manual verification runbook

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 19: Full green — suite, typecheck, lint, format

**Files:** none (verification + any fixups)

- [ ] **Step 1: Run the whole workspace test suite**

Run: `pnpm -r test`
Expected: all packages + the service suite PASS (Phase 3's ~145 plus the new Phase 4 tests).

- [ ] **Step 2: Typecheck the whole workspace**

Run: `pnpm -r typecheck`
Expected: exits 0.

- [ ] **Step 3: Lint and format**

Run: `pnpm -r lint`
Expected: exits 0 (fix any warnings the new files introduce — e.g. drop unused `THREAD_STATES`/`void` lines if flagged).

Run: `pnpm format` (or `pnpm -r format` / the repo's format script)
Expected: no diffs after running, or only the new files normalized.

- [ ] **Step 4: Commit any fixups**

```bash
git add -A
git commit -F - <<'MSG'
chore(service): lint/format fixups for Phase 4

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

(Skip the commit if nothing changed.)

---

## Notes for the implementer

- **Build `@secretary/shared-types` (Task 1) before running any service test** — the service resolves the package from `dist/`. If service tests fail with "has no exported member ClassificationResult", re-run `pnpm --filter @secretary/shared-types build`.
- **Native module ABI:** tests and `dev:server` need the Node-ABI build of `better-sqlite3-multiple-ciphers`. If you previously ran `rebuild:electron`, run `pnpm --filter @secretary/service rebuild` first.
- **Windows temp DBs:** always `db.close()` before the `afterEach` `rmSync`, or the directory removal fails on a locked file.
- **Don't run the Electron tray** during this work — it needs the Electron ABI and would break the suite.
- The agent layer never logs message bodies or prompts (BRIEF §5) — `action_log` details carry only enums/ids.
