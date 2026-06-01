# PWA Designed Screens (Needs Attention + Draft Review) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Phase-2.5 placeholder route bodies with the two real screens — Needs Attention (sender-led cards) and the thread/draft-review screen (conversation + editable draft + review→edit→send loop) — plus the small server enrichments they need.

**Architecture:** Enrich the existing `GET /threads/:id` (add `currentDraft` + `senderName`) and `GET /threads/needs-attention` items (add `hasDraft` + `senderName`); the PWA reads these through the existing typed hooks + SSE invalidation and renders the two screens, wiring the unchanged Phase-5 drafts endpoints (`POST/PATCH/send/DELETE /drafts`).

**Tech Stack:** Fastify 5 + better-sqlite3 (service); Vite + React 18 + TS + Tailwind + wouter + TanStack Query (PWA); Vitest (both).

**Spec:** `docs/superpowers/specs/2026-05-31-pwa-screens-design.md`

---

## Conventions

- Two packages: `@secretary/service` (Node, strict NodeNext, `.js` import extensions) and `@secretary/pwa` (browser, bundler resolution, DOM). Both strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- **Service**: test `pnpm --filter @secretary/service test [substr]`; typecheck `pnpm --filter @secretary/service typecheck`. Test harness: `makeTestServer()` → `{ app, session, db }`; seed via `db.prepare(INSERT…).run()` or the repositories; assert via `app.inject` + `res.json().data`.
- **PWA**: test `pnpm --filter @secretary/pwa test [substr]`; typecheck `…typecheck`; build `…build`; dev `…dev`. Vitest jsdom.
- **TDD the logic** (server enrichments via `app.inject`; pure client utils). **Per BRIEF §18 the UI is manually verified** — React components are _scaffold → typecheck → build → manual runbook_, not fake-tested. One light render test guards each non-trivial presentational unit where cheap.
- Commits: conventional; co-author trailer:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```
  Use the Bash heredoc form `git commit -F - <<'MSG' … MSG` (never PowerShell here-strings). Windows; service tests need the current Node ABI (do NOT run `pnpm dev`/`rebuild:electron`).
- Branch: `feat/pwa-screens` (already created, off `main` with the spec committed).

## File Structure

**Service — modify/create:**

- `packages/shared-types/src/domain.ts` — add fields to `NeedsAttentionItem` + `ThreadWithMessages`.
- `apps/service/server/db/repositories/DraftsRepository.ts` — add `currentForThread`.
- `apps/service/server/api/views.ts` — **new**: shared `parseAddrs`, `draftView`, `resolveSenderName` (extracted from `drafts.ts`/`threads.ts`).
- `apps/service/server/api/drafts.ts` — use shared `draftView`/`parseAddrs`.
- `apps/service/server/api/threads.ts` — enrich `GET /threads/:id` + needs-attention items.
- Tests: `apps/service/test/drafts-repository.test.ts` (new or extend), `apps/service/test/threads-routes.test.ts` (extend).

**PWA — modify/create:**

- `apps/service/pwa/src/util/timeAgo.ts` (+ `timeAgo.test.ts`) — **new**.
- `apps/service/pwa/src/api/hooks.ts` — add generate/regenerate/edit/discard mutations.
- `apps/service/pwa/src/components/UrgencyPill.tsx`, `DiffView.tsx`, `NeedsAttentionCard.tsx`, `MessageList.tsx`, `DraftPanel.tsx`, `SendConfirmSheet.tsx` — **new**.
- `apps/service/pwa/src/routes/NeedsAttention.tsx`, `ThreadView.tsx` — rewrite from placeholders.

**Docs:** `BRIEF.md` (deviations note); `docs/PHASE-2.5b-MANUAL-VERIFICATION.md` (runbook).

---

### Task 1: Server — shared views + `currentForThread` + DTO fields

Foundation for the endpoint enrichments: the DTO fields, a draft-selection method that excludes `sent`/`discarded`, and a shared `views.ts` so both route files build a `DraftView` the same way.

**Files:**

- Modify: `packages/shared-types/src/domain.ts`
- Modify: `apps/service/server/db/repositories/DraftsRepository.ts`
- Create: `apps/service/server/api/views.ts`
- Modify: `apps/service/server/api/drafts.ts`
- Create/extend: `apps/service/test/drafts-repository.test.ts`

- [ ] **Step 1: Add the DTO fields**

In `packages/shared-types/src/domain.ts`, extend the two interfaces (keep existing fields):

```typescript
/** A row on the Needs Attention screen (BRIEF §9 / §12). */
export interface NeedsAttentionItem extends ThreadSummary {
  senderName: string;
  hasDraft: boolean;
  urgency: Urgency | null;
  slaDeadline: string | null;
  summary: string | null;
  hasPendingFollowUp: boolean;
}

export interface ThreadWithMessages extends ThreadSummary {
  senderName: string;
  messages: MessageView[];
  currentDraft: DraftView | null;
}
```

Run `pnpm --filter @secretary/shared-types build` (the package emits `dist/`; downstream packages consume the built types). Confirm exit 0.

- [ ] **Step 2: Write the failing repo test**

Create `apps/service/test/drafts-repository.test.ts` (if it exists, append the `currentForThread` describe block):

```typescript
import { describe, expect, it } from 'vitest';
import { makeTestServer } from './helpers/testServer.js';
import { DraftsRepository } from '../server/db/repositories/DraftsRepository.js';

function seedDraft(db: import('better-sqlite3-multiple-ciphers').Database, version: number) {
  return new DraftsRepository(db).insert({
    threadId: 'th1',
    accountId: 'acc1',
    version,
    inReplyToMessageId: null,
    to: [{ address: 'a@b.com' }],
    cc: [],
    subject: 'Re: hi',
    bodyText: 'body',
    rawIntent: null,
    polishDiff: null,
    systemPromptUsed: 'p',
    modelUsed: 'm',
    tokensIn: 1,
    tokensOut: 1,
    latencyMs: 1,
    createdAt: 1000 * version,
  });
}

describe('DraftsRepository.currentForThread', () => {
  it('returns the latest draft that is not sent or discarded', async () => {
    const { app, db } = await makeTestServer();
    const repo = new DraftsRepository(db);
    const v1 = seedDraft(db, 1);
    const v2 = seedDraft(db, 2);
    // v2 is pending_review (default) → current
    expect(repo.currentForThread('th1')?.id).toBe(v2);
    // discard v2 → falls back to v1 (still pending)
    repo.markDiscarded(v2);
    expect(repo.currentForThread('th1')?.id).toBe(v1);
    // send v1 → no current draft
    repo.markSent(v1, { sentAt: 1, finalBodySent: 'body' });
    expect(repo.currentForThread('th1')).toBeUndefined();
    await app.close();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @secretary/service test drafts-repository`
Expected: FAIL — `currentForThread` is not a function.

- [ ] **Step 4: Implement `currentForThread`**

In `apps/service/server/db/repositories/DraftsRepository.ts`, add after `latestForThread`:

```typescript
  /** Highest-version draft for a thread that is still reviewable (not sent/discarded). */
  currentForThread(threadId: string): DraftRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM drafts WHERE thread_id = ? AND status NOT IN ('sent','discarded')
         ORDER BY version DESC LIMIT 1`,
      )
      .get(threadId) as DraftRow | undefined;
  }
```

- [ ] **Step 5: Create the shared `views.ts`**

Create `apps/service/server/api/views.ts`:

```typescript
import type { DiffOp, DraftView, EmailAddress } from '@secretary/shared-types';
import type { DraftRow, ThreadRow } from '../db/schema.js';
import type { MessagesRepository } from '../db/repositories/MessagesRepository.js';
import type { ContactsRepository } from '../db/repositories/ContactsRepository.js';

export function parseAddrs(json: string | null): EmailAddress[] {
  if (!json) return [];
  try {
    return JSON.parse(json) as EmailAddress[];
  } catch {
    return [];
  }
}

export function draftView(row: DraftRow): DraftView {
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

/** Friendly sender name: latest inbound from-address → contact display_name → from_name → email; fallback to first participant / subject / "Unknown". */
export function resolveSenderName(
  threadRow: ThreadRow,
  messages: MessagesRepository,
  contacts: ContactsRepository,
): string {
  const latest = messages.latestInboundForThread(threadRow.id);
  if (latest) {
    const contact = contacts.findByEmail(latest.from_address);
    return contact?.display_name ?? latest.from_name ?? latest.from_address;
  }
  const participants = threadRow.participants
    ? (JSON.parse(threadRow.participants) as string[])
    : [];
  return participants[0] ?? threadRow.subject_normalized ?? 'Unknown';
}
```

NOTE: confirm `MessagesRepository` exposes `latestInboundForThread(threadId): MessageRow | undefined` (it does — used by the classify route). Confirm `MessageRow` has `from_address`/`from_name` and `ContactRow` has `display_name` (both verified in the schema).

- [ ] **Step 6: Use the shared `draftView`/`parseAddrs` in `drafts.ts`**

In `apps/service/server/api/drafts.ts`, remove the local `parseAddrs` and `draftView` definitions and import them:

```typescript
import { draftView, parseAddrs } from './views.js';
```

(Keep everything else. The `send` route still calls `parseAddrs(draft.to_addresses)`.)

- [ ] **Step 7: Run tests + typecheck**

Run: `pnpm --filter @secretary/service test drafts-repository` → PASS.
Run: `pnpm --filter @secretary/service test` → all green (drafts routes still pass with the shared `draftView`).
Run: `pnpm --filter @secretary/service typecheck` → exit 0.

- [ ] **Step 8: Commit**

```bash
git add packages/shared-types apps/service/server/api/views.ts apps/service/server/api/drafts.ts apps/service/server/db/repositories/DraftsRepository.ts apps/service/test/drafts-repository.test.ts
git commit -F - <<'MSG'
feat(service): shared views + DraftsRepository.currentForThread + draft/sender DTO fields

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 2: Server — enrich `GET /threads/:id` (currentDraft + senderName)

**Files:**

- Modify: `apps/service/server/api/threads.ts`
- Modify: `apps/service/test/threads-routes.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `apps/service/test/threads-routes.test.ts` inside a new `describe`:

```typescript
import { DraftsRepository } from '../server/db/repositories/DraftsRepository.js';

describe('thread detail enrichment', () => {
  it('includes senderName (contact display name) and the current draft', async () => {
    const { app, session, db } = await makeTestServer();
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','me@x.com')`,
    ).run();
    db.prepare(
      `INSERT INTO contacts (id, email_address, display_name, category, total_messages_in, total_messages_out, do_not_auto_draft) VALUES ('c1','jane@x.com','Jane Doe','client',1,0,0)`,
    ).run();
    db.prepare(
      `INSERT INTO threads (id, account_id, subject_normalized, participants, message_count, last_message_at, state) VALUES ('th1','acc1','Hi','["jane@x.com"]',1,1000,'awaiting_your_reply')`,
    ).run();
    db.prepare(
      `INSERT INTO messages (id, account_id, provider_id, thread_id, from_address, from_name, direction, date_received, subject, snippet) VALUES ('m1','acc1','u1','th1','jane@x.com','J. Doe','inbound',1000,'Hi','hello')`,
    ).run();
    new DraftsRepository(db).insert({
      threadId: 'th1',
      accountId: 'acc1',
      version: 1,
      inReplyToMessageId: null,
      to: [{ address: 'jane@x.com' }],
      cc: [],
      subject: 'Re: Hi',
      bodyText: 'Hello back',
      rawIntent: null,
      polishDiff: null,
      systemPromptUsed: 'p',
      modelUsed: 'm',
      tokensIn: 1,
      tokensOut: 1,
      latencyMs: 1,
      createdAt: 2000,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/threads/th1',
      headers: { authorization: `Bearer ${session}` },
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.senderName).toBe('Jane Doe');
    expect(data.currentDraft).not.toBeNull();
    expect(data.currentDraft.bodyText).toBe('Hello back');
    await app.close();
  });

  it('currentDraft is null when there is no reviewable draft; senderName falls back to from_name then email', async () => {
    const { app, session, db } = await makeTestServer();
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','me@x.com')`,
    ).run();
    db.prepare(
      `INSERT INTO threads (id, account_id, subject_normalized, participants, message_count, last_message_at, state) VALUES ('th2','acc1','Hi','["bob@x.com"]',1,1000,'awaiting_your_reply')`,
    ).run();
    db.prepare(
      `INSERT INTO messages (id, account_id, provider_id, thread_id, from_address, from_name, direction, date_received) VALUES ('m2','acc1','u2','th2','bob@x.com','Bob','inbound',1000)`,
    ).run();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/threads/th2',
      headers: { authorization: `Bearer ${session}` },
    });
    const { data } = res.json();
    expect(data.currentDraft).toBeNull();
    expect(data.senderName).toBe('Bob'); // no contact row → from_name
    await app.close();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @secretary/service test threads-routes`
Expected: FAIL — `senderName`/`currentDraft` undefined on the response.

- [ ] **Step 3: Implement the enrichment**

In `apps/service/server/api/threads.ts`:

- Replace the local `parseAddrs` with the shared import and add the other helpers:
  ```typescript
  import { draftView, resolveSenderName } from './views.js';
  import { ContactsRepository } from '../db/repositories/ContactsRepository.js';
  import { DraftsRepository } from '../db/repositories/DraftsRepository.js';
  ```
  (Keep the local `threadSummary`/`needsAttentionItem`/`messageView`. If `parseAddrs` is now only used by `messageView`, leave the local one or import the shared — either is fine; don't break `messageView`.)
- In `registerThreadsRoutes`, construct the extra repos alongside the existing ones:
  ```typescript
  const contacts = new ContactsRepository(deps.db);
  const drafts = new DraftsRepository(deps.db);
  ```
- Replace the `GET /threads/:id` handler body:

  ```typescript
  app.get('/threads/:id', async (req) => {
    const { id } = req.params as { id: string };
    const row = threads.get(id);
    if (!row) throw new NotFoundError('Thread not found');
    const draftRow = drafts.currentForThread(id);
    const view: ThreadWithMessages = {
      ...threadSummary(row),
      senderName: resolveSenderName(row, messages, contacts),
      messages: messages.listByThread(id).map(messageView),
      currentDraft: draftRow ? draftView(draftRow) : null,
    };
    return { data: view };
  });
  ```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @secretary/service test threads-routes` → PASS (incl. the existing tests).
Run: `pnpm --filter @secretary/service typecheck` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/service/server/api/threads.ts apps/service/test/threads-routes.test.ts
git commit -F - <<'MSG'
feat(service): GET /threads/:id returns currentDraft + senderName

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 3: Server — enrich needs-attention items (hasDraft + senderName)

**Files:**

- Modify: `apps/service/server/api/threads.ts`
- Modify: `apps/service/test/threads-routes.test.ts`

- [ ] **Step 1: Add a failing test**

Append to the `threads attention/state/classify routes` describe (or a new one) in `threads-routes.test.ts`:

```typescript
it('needs-attention items carry senderName and hasDraft', async () => {
  const { app, session, db } = await makeTestServer();
  db.prepare(
    `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','me@x.com')`,
  ).run();
  db.prepare(
    `INSERT INTO contacts (id, email_address, display_name, category, total_messages_in, total_messages_out, do_not_auto_draft) VALUES ('c1','jane@x.com','Jane Doe','client',1,0,0)`,
  ).run();
  db.prepare(
    `INSERT INTO threads (id, account_id, subject_normalized, participants, message_count, last_message_at, state, urgency, sla_deadline) VALUES ('th1','acc1','Hi','["jane@x.com"]',1,1000,'awaiting_your_reply','high',5000)`,
  ).run();
  db.prepare(
    `INSERT INTO messages (id, account_id, provider_id, thread_id, from_address, direction, date_received) VALUES ('m1','acc1','u1','th1','jane@x.com','inbound',1000)`,
  ).run();
  new (await import('../server/db/repositories/DraftsRepository.js')).DraftsRepository(db).insert({
    threadId: 'th1',
    accountId: 'acc1',
    version: 1,
    inReplyToMessageId: null,
    to: [{ address: 'jane@x.com' }],
    cc: [],
    subject: 'Re',
    bodyText: 'b',
    rawIntent: null,
    polishDiff: null,
    systemPromptUsed: 'p',
    modelUsed: 'm',
    tokensIn: 1,
    tokensOut: 1,
    latencyMs: 1,
    createdAt: 2000,
  });

  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/threads/needs-attention',
    headers: { authorization: `Bearer ${session}` },
  });
  const item = res.json().data[0];
  expect(item.senderName).toBe('Jane Doe');
  expect(item.hasDraft).toBe(true);
  await app.close();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @secretary/service test threads-routes`
Expected: FAIL — `senderName`/`hasDraft` missing on needs-attention items.

- [ ] **Step 3: Implement the enrichment**

In `apps/service/server/api/threads.ts`, change the needs-attention handler to enrich each row (the `needsAttentionItem` mapper stays pure for the base fields; enrich in the handler where the repos are in scope):

```typescript
app.get('/threads/needs-attention', async () => ({
  data: threads.needsAttention().map((row) => ({
    ...needsAttentionItem(row),
    senderName: resolveSenderName(row, messages, contacts),
    hasDraft: drafts.currentForThread(row.id) !== undefined,
  })),
}));
```

(`AttentionRow` extends the thread row, so `resolveSenderName(row, …)` typechecks — it reads `row.id`/`row.participants`/`row.subject_normalized`. If TS complains that `AttentionRow` isn't assignable to `ThreadRow`, widen `resolveSenderName`'s parameter to `Pick<ThreadRow, 'id' | 'participants' | 'subject_normalized'>`.)

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @secretary/service test threads-routes` → PASS (incl. the existing ordering test).
Run: `pnpm --filter @secretary/service test` → all green.
Run: `pnpm --filter @secretary/service typecheck` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/service/server/api/threads.ts apps/service/test/threads-routes.test.ts
git commit -F - <<'MSG'
feat(service): needs-attention items carry senderName + hasDraft

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 4: PWA — `formatTimeAgo` util (TDD)

**Files:**

- Create: `apps/service/pwa/src/util/timeAgo.ts`, `apps/service/pwa/src/util/timeAgo.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/service/pwa/src/util/timeAgo.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { formatTimeAgo } from './timeAgo.js';

const NOW = new Date('2026-05-31T12:00:00.000Z').getTime();

describe('formatTimeAgo', () => {
  it('formats recent, minutes, hours, and days', () => {
    expect(formatTimeAgo(new Date(NOW - 10_000).toISOString(), NOW)).toBe('just now');
    expect(formatTimeAgo(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe('5m');
    expect(formatTimeAgo(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe('3h');
    expect(formatTimeAgo(new Date(NOW - 2 * 86_400_000).toISOString(), NOW)).toBe('2d');
  });
  it('handles null and far past', () => {
    expect(formatTimeAgo(null, NOW)).toBe('');
    expect(formatTimeAgo(new Date(NOW - 40 * 86_400_000).toISOString(), NOW)).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @secretary/pwa test timeAgo` → FAIL (module missing).

- [ ] **Step 3: Implement `timeAgo.ts`**

```typescript
/** Compact relative time: "just now", "5m", "3h", "2d", or an ISO date past 30 days. `now` is injectable for tests. */
export function formatTimeAgo(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const sec = Math.max(0, Math.floor((now - then) / 1000));
  if (sec < 45) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day <= 30) return `${day}d`;
  return new Date(then).toISOString().slice(0, 10);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @secretary/pwa test timeAgo` → PASS.
Run: `pnpm --filter @secretary/pwa typecheck` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/service/pwa/src/util/timeAgo.ts apps/service/pwa/src/util/timeAgo.test.ts
git commit -F - <<'MSG'
feat(pwa): formatTimeAgo util

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 5: PWA — draft mutation hooks

Add the generate/regenerate/edit/discard mutations; keep `useSendDraft`. These supersede the foundation's `useCreateDraft` (remove it). Scaffold + typecheck (thin wrappers over `apiFetch`).

**Files:**

- Modify: `apps/service/pwa/src/api/hooks.ts`

- [ ] **Step 1: Replace the draft mutations**

In `apps/service/pwa/src/api/hooks.ts`, ensure `DraftView` is imported, **remove `useCreateDraft`**, and add (keep the query hooks + `useSendDraft`):

```typescript
/** Generate the first draft for a thread (no draft yet). */
export function useGenerateDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { threadId: string; rawIntent?: string }) =>
      apiFetch<DraftView>('/drafts', { method: 'POST', body: JSON.stringify(vars) }),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ['thread', vars.threadId] });
      void qc.invalidateQueries({ queryKey: ['needs-attention'] });
    },
  });
}

/** Regenerate a thread's draft (new version), optionally with a new raw intent. */
export function useRegenerateDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { threadId: string; rawIntent?: string }) =>
      apiFetch<DraftView>('/drafts', {
        method: 'POST',
        body: JSON.stringify({ ...vars, regenerate: true }),
      }),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ['thread', vars.threadId] });
    },
  });
}

/** Save edits to a draft's body/subject. */
export function useEditDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      draftId: string;
      threadId: string;
      bodyText?: string;
      subject?: string;
    }) =>
      apiFetch<DraftView>(`/drafts/${vars.draftId}`, {
        method: 'PATCH',
        body: JSON.stringify({ bodyText: vars.bodyText, subject: vars.subject }),
      }),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ['thread', vars.threadId] });
    },
  });
}

/** Discard a draft. */
export function useDiscardDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { draftId: string; threadId: string }) =>
      apiFetch<{ discarded: boolean }>(`/drafts/${vars.draftId}`, { method: 'DELETE' }),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ['thread', vars.threadId] });
      void qc.invalidateQueries({ queryKey: ['needs-attention'] });
    },
  });
}
```

Update `useSendDraft` to take `threadId` too and invalidate the thread:

```typescript
export function useSendDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { draftId: string; threadId: string }) =>
      apiFetch<{ providerMessageId: string; threadState: string }>(`/drafts/${vars.draftId}/send`, {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ['needs-attention'] });
      void qc.invalidateQueries({ queryKey: ['thread', vars.threadId] });
    },
  });
}
```

NOTE on PATCH with `exactOptionalPropertyTypes`: sending `{ bodyText: undefined }` serializes to `{}` via `JSON.stringify` (undefined keys are dropped) — the server's `patchSchema` accepts both optional. Fine.

- [ ] **Step 2: Typecheck + commit**

Run: `pnpm --filter @secretary/pwa typecheck` → exit 0.
Run: `pnpm --filter @secretary/pwa test` → existing tests still pass (no consumer of `useCreateDraft` exists yet — the placeholder routes don't use it).

```bash
git add apps/service/pwa/src/api/hooks.ts
git commit -F - <<'MSG'
feat(pwa): draft generate/regenerate/edit/discard mutation hooks

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 6: PWA — `UrgencyPill` + `DiffView` presentational components

**Files:**

- Create: `apps/service/pwa/src/components/UrgencyPill.tsx`, `apps/service/pwa/src/components/DiffView.tsx`, `apps/service/pwa/src/components/DiffView.test.tsx`

- [ ] **Step 1: `UrgencyPill.tsx`**

```typescript
import type { Urgency } from '@secretary/shared-types';

export function UrgencyPill({ urgency }: { urgency: Urgency | null }): JSX.Element | null {
  if (!urgency) return null;
  // Conditional (not a Record index) to stay clean under noUncheckedIndexedAccess.
  const cls =
    urgency === 'high'
      ? 'bg-red-100 text-red-700'
      : urgency === 'normal'
        ? 'bg-amber-100 text-amber-800'
        : 'bg-slate-100 text-slate-600';
  return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>{urgency}</span>;
}
```

(Confirm `Urgency` is exported by `@secretary/shared-types`. The `high`/`normal` branches match the live data; any other member falls through to the slate style.)

- [ ] **Step 2: Write a failing test for `DiffView`**

`apps/service/pwa/src/components/DiffView.test.tsx`:

```typescript
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DiffView } from './DiffView.js';

describe('DiffView', () => {
  it('renders eq/add/del lines', () => {
    render(
      <DiffView
        ops={[
          { op: 'eq', line: 'kept' },
          { op: 'add', line: 'added' },
          { op: 'del', line: 'removed' },
        ]}
      />,
    );
    expect(screen.getByText('kept')).toBeTruthy();
    expect(screen.getByText('added')).toBeTruthy();
    expect(screen.getByText('removed')).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run to verify failure** — `pnpm --filter @secretary/pwa test DiffView` → FAIL (module missing).

- [ ] **Step 4: Implement `DiffView.tsx`**

```typescript
import type { DiffOp } from '@secretary/shared-types';

const LINE: Record<DiffOp['op'], string> = {
  eq: 'text-slate-600',
  add: 'bg-green-50 text-green-700',
  del: 'bg-red-50 text-red-700 line-through',
};

export function DiffView({ ops }: { ops: DiffOp[] }): JSX.Element {
  return (
    <pre className="overflow-auto rounded-lg border border-slate-200 p-2 text-xs leading-relaxed">
      {ops.map((op, i) => (
        <div key={i} className={LINE[op.op]}>
          {op.op === 'add' ? '+ ' : op.op === 'del' ? '- ' : '  '}
          {op.line || ' '}
        </div>
      ))}
    </pre>
  );
}
```

- [ ] **Step 5: Run to verify pass** — `pnpm --filter @secretary/pwa test DiffView` → PASS; `…typecheck` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/service/pwa/src/components/UrgencyPill.tsx apps/service/pwa/src/components/DiffView.tsx apps/service/pwa/src/components/DiffView.test.tsx
git commit -F - <<'MSG'
feat(pwa): UrgencyPill + DiffView components

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 7: PWA — Needs Attention cards

**Files:**

- Create: `apps/service/pwa/src/components/NeedsAttentionCard.tsx`, `apps/service/pwa/src/components/NeedsAttentionCard.test.tsx`
- Rewrite: `apps/service/pwa/src/routes/NeedsAttention.tsx`

- [ ] **Step 1: Write a failing card render test**

`apps/service/pwa/src/components/NeedsAttentionCard.test.tsx`:

```typescript
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { NeedsAttentionCard } from './NeedsAttentionCard.js';
import type { NeedsAttentionItem } from '@secretary/shared-types';

const base: NeedsAttentionItem = {
  id: 't1', accountId: 'a', subject: 'Reschedule', participants: [], messageCount: 1,
  lastMessageAt: new Date(Date.now() - 3_600_000).toISOString(), state: 'awaiting_your_reply',
  senderName: 'Jane Doe', hasDraft: true, urgency: 'high', slaDeadline: null,
  summary: 'Asking to reschedule.', hasPendingFollowUp: false,
};

describe('NeedsAttentionCard', () => {
  it('shows sender, urgency, summary, and "Review draft" when a draft exists', () => {
    render(<Router><NeedsAttentionCard item={base} onGenerate={vi.fn()} generating={false} /></Router>);
    expect(screen.getByText('Jane Doe')).toBeTruthy();
    expect(screen.getByText('high')).toBeTruthy();
    expect(screen.getByText('Asking to reschedule.')).toBeTruthy();
    expect(screen.getByText(/Review draft/)).toBeTruthy();
  });

  it('shows "Generate draft" when no draft exists', () => {
    render(<Router><NeedsAttentionCard item={{ ...base, hasDraft: false }} onGenerate={vi.fn()} generating={false} /></Router>);
    expect(screen.getByText('Generate draft')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @secretary/pwa test NeedsAttentionCard` → FAIL (module missing).

- [ ] **Step 3: Implement `NeedsAttentionCard.tsx`**

```typescript
import { Link } from 'wouter';
import type { NeedsAttentionItem } from '@secretary/shared-types';
import { UrgencyPill } from './UrgencyPill.js';
import { formatTimeAgo } from '../util/timeAgo.js';

export function NeedsAttentionCard({
  item,
  onGenerate,
  generating,
}: {
  item: NeedsAttentionItem;
  onGenerate: (threadId: string) => void;
  generating: boolean;
}): JSX.Element {
  return (
    <li className="rounded-xl border border-slate-200 bg-white p-3">
      <Link href={`/threads/${item.id}`} className="block">
        <div className="flex items-center justify-between">
          <span className="text-[15px] font-semibold text-slate-900">{item.senderName}</span>
          <span className="text-xs text-slate-400">{formatTimeAgo(item.lastMessageAt)}</span>
        </div>
        <div className="my-1.5 flex items-center gap-2">
          <UrgencyPill urgency={item.urgency} />
          <span className="truncate text-xs text-slate-400">{item.subject ?? '(no subject)'}</span>
        </div>
        {item.summary ? <p className="text-[13px] leading-snug text-slate-600">{item.summary}</p> : null}
      </Link>
      <div className="mt-2.5 flex justify-end">
        {item.hasDraft ? (
          <Link
            href={`/threads/${item.id}`}
            className="rounded-lg bg-slate-900 px-3.5 py-2 text-[13px] font-semibold text-white"
          >
            Review draft ▸
          </Link>
        ) : (
          <button
            type="button"
            disabled={generating}
            onClick={() => onGenerate(item.id)}
            className="rounded-lg border border-slate-300 px-3.5 py-2 text-[13px] font-medium text-slate-700 disabled:opacity-50"
          >
            {generating ? 'Generating…' : 'Generate draft'}
          </button>
        )}
      </div>
    </li>
  );
}
```

- [ ] **Step 4: Run to verify pass** — `pnpm --filter @secretary/pwa test NeedsAttentionCard` → PASS.

- [ ] **Step 5: Rewrite `NeedsAttention.tsx`**

```typescript
import { useState } from 'react';
import { useLocation } from 'wouter';
import { useNeedsAttention, useGenerateDraft } from '../api/hooks.js';
import { NeedsAttentionCard } from '../components/NeedsAttentionCard.js';

export function NeedsAttention(): JSX.Element {
  const q = useNeedsAttention();
  const generate = useGenerateDraft();
  const [, setLocation] = useLocation();
  const [generatingId, setGeneratingId] = useState<string | null>(null);

  if (q.isLoading) return <p>Loading…</p>;
  if (q.error) return <p className="text-red-600">{(q.error as Error).message}</p>;
  const items = q.data ?? [];
  if (items.length === 0) return <p className="text-slate-500">Nothing needs attention.</p>;

  const onGenerate = (threadId: string): void => {
    setGeneratingId(threadId);
    generate.mutate(
      { threadId },
      {
        onSuccess: () => setLocation(`/threads/${threadId}`),
        onSettled: () => setGeneratingId(null),
      },
    );
  };

  return (
    <ul className="flex flex-col gap-2.5">
      {items.map((item) => (
        <NeedsAttentionCard
          key={item.id}
          item={item}
          onGenerate={onGenerate}
          generating={generatingId === item.id}
        />
      ))}
    </ul>
  );
}
```

- [ ] **Step 6: Typecheck + manual smoke + commit**

Run: `pnpm --filter @secretary/pwa typecheck` → exit 0; `pnpm --filter @secretary/pwa test` → all PASS.
(Full visual verification is in the runbook, Task 11.)

```bash
git add apps/service/pwa/src/components/NeedsAttentionCard.tsx apps/service/pwa/src/components/NeedsAttentionCard.test.tsx apps/service/pwa/src/routes/NeedsAttention.tsx
git commit -F - <<'MSG'
feat(pwa): Needs Attention cards

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 8: PWA — conversation + draft panel + send-confirm sheet

The thread screen's building blocks. Scaffold + typecheck (UI verified in the runbook). One light render test for `DraftPanel`'s diff-toggle gating.

**Files:**

- Create: `apps/service/pwa/src/components/MessageList.tsx`, `DraftPanel.tsx`, `SendConfirmSheet.tsx`, `DraftPanel.test.tsx`

- [ ] **Step 1: `MessageList.tsx`** (conversation; latest inbound expanded by default, others tap-to-toggle)

```typescript
import { useState } from 'react';
import type { MessageView } from '@secretary/shared-types';

function MessageItem({ m, defaultOpen }: { m: MessageView; defaultOpen: boolean }): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <li className="rounded-lg border border-slate-200">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-left"
      >
        <span className="text-xs text-slate-500">
          {m.direction} · {m.from.name ?? m.from.address}
        </span>
        <span className="text-xs text-slate-400">{open ? '▾' : '▸'}</span>
      </button>
      {open ? (
        <p className="whitespace-pre-wrap px-3 pb-3 text-[13px] leading-relaxed text-slate-700">
          {m.bodyText ?? m.snippet ?? ''}
        </p>
      ) : (
        <p className="truncate px-3 pb-2 text-[13px] text-slate-400">{m.snippet ?? ''}</p>
      )}
    </li>
  );
}

export function MessageList({ messages }: { messages: MessageView[] }): JSX.Element {
  // Expand the latest inbound message by default.
  let lastInbound = -1;
  messages.forEach((m, i) => {
    if (m.direction === 'inbound') lastInbound = i;
  });
  return (
    <ul className="flex flex-col gap-2">
      {messages.map((m, i) => (
        <MessageItem key={m.id} m={m} defaultOpen={i === lastInbound} />
      ))}
    </ul>
  );
}
```

- [ ] **Step 2: `SendConfirmSheet.tsx`**

```typescript
import type { DraftView } from '@secretary/shared-types';

export function SendConfirmSheet({
  draft,
  sending,
  onCancel,
  onConfirm,
}: {
  draft: DraftView;
  sending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): JSX.Element {
  const to = draft.to[0]?.address ?? '(no recipient)';
  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-slate-900/35" onClick={onCancel}>
      <div
        className="w-full max-w-[720px] rounded-t-2xl bg-white p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-[15px] font-bold text-slate-900">Send this draft as-is?</h2>
        <p className="mb-3 mt-1 text-xs text-slate-500">
          To: {to} · {draft.subject ?? '(no subject)'}
        </p>
        <div className="flex gap-2.5">
          <button
            type="button"
            onClick={onCancel}
            className="min-h-[44px] flex-1 rounded-lg border border-slate-300 text-slate-700"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={sending}
            onClick={onConfirm}
            className="min-h-[44px] flex-1 rounded-lg bg-slate-900 font-semibold text-white disabled:opacity-50"
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Write a failing test for `DraftPanel` (diff toggle gating)**

`apps/service/pwa/src/components/DraftPanel.test.tsx`:

```typescript
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DraftPanel } from './DraftPanel.js';
import type { DraftView } from '@secretary/shared-types';

const draft = (over: Partial<DraftView> = {}): DraftView => ({
  id: 'd1', threadId: 't1', accountId: 'a', version: 2, to: [{ address: 'x@y.com' }], cc: [],
  subject: 'Re', bodyText: 'Hello', rawIntent: 'be brief', polishDiff: [{ op: 'eq', line: 'Hello' }],
  status: 'pending_review', modelUsed: 'm', createdAt: null, sentAt: null, ...over,
});

const noop = vi.fn();
const handlers = { onBodyChange: noop, onRegenerate: noop, onEditIntent: noop, onSend: noop, onDiscard: noop };

describe('DraftPanel', () => {
  it('shows the diff when toggled (raw intent present)', () => {
    render(<DraftPanel draft={draft()} body="Hello" busy={false} {...handlers} />);
    fireEvent.click(screen.getByText('diff'));
    expect(screen.getByText('Hello')).toBeTruthy(); // diff line rendered
  });
  it('disables the diff toggle when there is no polish diff', () => {
    render(<DraftPanel draft={draft({ polishDiff: null, rawIntent: null })} body="Hello" busy={false} {...handlers} />);
    expect((screen.getByText('diff') as HTMLButtonElement).disabled).toBe(true);
  });
});
```

- [ ] **Step 4: Run to verify failure** — `pnpm --filter @secretary/pwa test DraftPanel` → FAIL (module missing).

- [ ] **Step 5: Implement `DraftPanel.tsx`**

```typescript
import { useState } from 'react';
import type { DraftView } from '@secretary/shared-types';
import { DiffView } from './DiffView.js';

export function DraftPanel({
  draft,
  body,
  busy,
  onBodyChange,
  onRegenerate,
  onEditIntent,
  onSend,
  onDiscard,
}: {
  draft: DraftView;
  body: string;
  busy: boolean;
  onBodyChange: (v: string) => void;
  onRegenerate: () => void;
  onEditIntent: (intent: string) => void;
  onSend: () => void;
  onDiscard: () => void;
}): JSX.Element {
  const [showDiff, setShowDiff] = useState(false);
  const [editingIntent, setEditingIntent] = useState(false);
  const [intent, setIntent] = useState(draft.rawIntent ?? '');
  const hasDiff = !!draft.polishDiff && draft.polishDiff.length > 0;

  return (
    <div className="flex flex-1 flex-col">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wide text-slate-400">
          Draft · v{draft.version}
          {draft.status === 'failed' ? <span className="ml-2 text-red-600">send failed</span> : null}
        </span>
        <button
          type="button"
          disabled={!hasDiff}
          onClick={() => setShowDiff((v) => !v)}
          className="text-xs text-blue-600 underline disabled:text-slate-300 disabled:no-underline"
        >
          diff
        </button>
      </div>

      {showDiff && hasDiff ? (
        <DiffView ops={draft.polishDiff ?? []} />
      ) : (
        <textarea
          value={body}
          onChange={(e) => onBodyChange(e.target.value)}
          className="min-h-[140px] flex-1 rounded-lg border border-slate-300 p-2.5 text-[13px] leading-relaxed text-slate-900"
        />
      )}

      {editingIntent ? (
        <div className="mt-2 flex gap-2">
          <input
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            placeholder="what should this say?"
            className="flex-1 rounded-lg border border-slate-300 px-2 py-1.5 text-[13px]"
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              onEditIntent(intent);
              setEditingIntent(false);
            }}
            className="rounded-lg bg-slate-900 px-3 text-xs font-semibold text-white disabled:opacity-50"
          >
            Regenerate
          </button>
        </div>
      ) : draft.rawIntent ? (
        <p className="mt-1.5 text-xs text-slate-500">
          intent: <em>"{draft.rawIntent}"</em>
        </p>
      ) : null}

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onRegenerate}
          className="rounded-lg border border-slate-300 px-2.5 py-2 text-xs text-slate-700 disabled:opacity-50"
        >
          ↻ Regenerate
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => setEditingIntent((v) => !v)}
          className="rounded-lg border border-slate-300 px-2.5 py-2 text-xs text-slate-700 disabled:opacity-50"
        >
          Edit intent
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onDiscard}
          className="rounded-lg border border-slate-300 px-2.5 py-2 text-xs text-slate-500 disabled:opacity-50"
        >
          Discard
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onSend}
          className="flex-1 rounded-lg bg-slate-900 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Run to verify pass + typecheck**

Run: `pnpm --filter @secretary/pwa test DraftPanel` → PASS.
Run: `pnpm --filter @secretary/pwa typecheck` → exit 0.

- [ ] **Step 7: Commit**

```bash
git add apps/service/pwa/src/components/MessageList.tsx apps/service/pwa/src/components/DraftPanel.tsx apps/service/pwa/src/components/DraftPanel.test.tsx apps/service/pwa/src/components/SendConfirmSheet.tsx
git commit -F - <<'MSG'
feat(pwa): conversation list, draft panel, send-confirm sheet

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 9: PWA — ThreadView screen wiring

Rewrite the placeholder to compose the conversation + draft panel + send flow, handling the no-draft (generate) and draft-loaded states.

**Files:**

- Rewrite: `apps/service/pwa/src/routes/ThreadView.tsx`

- [ ] **Step 1: Rewrite `ThreadView.tsx`**

```typescript
import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import {
  useThread,
  useGenerateDraft,
  useRegenerateDraft,
  useEditDraft,
  useDiscardDraft,
  useSendDraft,
} from '../api/hooks.js';
import { MessageList } from '../components/MessageList.js';
import { DraftPanel } from '../components/DraftPanel.js';
import { SendConfirmSheet } from '../components/SendConfirmSheet.js';

export function ThreadView({ id }: { id: string }): JSX.Element {
  const q = useThread(id);
  const generate = useGenerateDraft();
  const regenerate = useRegenerateDraft();
  const edit = useEditDraft();
  const discard = useDiscardDraft();
  const send = useSendDraft();
  const [, setLocation] = useLocation();

  const draft = q.data?.currentDraft ?? null;
  const [body, setBody] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Re-seed the editor when a new draft version arrives (generate/regenerate).
  useEffect(() => {
    if (draft) setBody(draft.bodyText);
  }, [draft?.id, draft?.version]);

  if (q.isLoading) return <p>Loading…</p>;
  if (q.error) return <p className="text-red-600">{(q.error as Error).message}</p>;
  const t = q.data;
  if (!t) return <p>Not found.</p>;

  const busy =
    generate.isPending || regenerate.isPending || edit.isPending || discard.isPending || send.isPending;
  const fail = (e: unknown): void => setErr(e instanceof Error ? e.message : 'Something went wrong');

  return (
    <div className="flex min-h-[70vh] flex-col">
      <h2 className="mb-1 font-semibold">{t.subject ?? '(no subject)'}</h2>
      <p className="mb-3 text-xs text-slate-500">{t.senderName} · {t.state}</p>

      <MessageList messages={t.messages} />

      <div className="mt-4 flex flex-1 flex-col">
        {err ? <p className="mb-2 text-sm text-red-600">{err}</p> : null}
        {draft ? (
          <DraftPanel
            draft={draft}
            body={body}
            busy={busy}
            onBodyChange={setBody}
            onRegenerate={() => {
              setErr(null);
              regenerate.mutate({ threadId: id }, { onError: fail });
            }}
            onEditIntent={(intent) => {
              setErr(null);
              regenerate.mutate({ threadId: id, rawIntent: intent }, { onError: fail });
            }}
            onDiscard={() => {
              setErr(null);
              discard.mutate({ draftId: draft.id, threadId: id }, { onError: fail });
            }}
            onSend={() => setConfirming(true)}
          />
        ) : (
          <div className="flex flex-col items-center gap-3 py-8">
            <p className="text-sm text-slate-500">No draft yet.</p>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setErr(null);
                generate.mutate({ threadId: id }, { onError: fail });
              }}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {generate.isPending ? 'Generating…' : 'Generate draft'}
            </button>
          </div>
        )}
      </div>

      {confirming && draft ? (
        <SendConfirmSheet
          draft={draft}
          sending={send.isPending || edit.isPending}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setErr(null);
            // Save the current body, then send (what you see is what sends).
            // The UI edits only the body; subject is left as-is (omitted from the PATCH).
            edit.mutate(
              { draftId: draft.id, threadId: id, bodyText: body },
              {
                onError: (e) => {
                  setConfirming(false);
                  fail(e);
                },
                onSuccess: () => {
                  send.mutate(
                    { draftId: draft.id, threadId: id },
                    {
                      onSuccess: () => {
                        setConfirming(false);
                        setLocation('/needs-attention');
                      },
                      onError: (e) => {
                        setConfirming(false);
                        fail(e);
                      },
                    },
                  );
                },
              },
            );
          }}
        />
      ) : null}
    </div>
  );
}
```

NOTE: the `App.tsx` route already passes `id` via `<Route path="/threads/:id">{(p) => <ThreadView id={p.id ?? ''} />}</Route>` — unchanged.

- [ ] **Step 2: Typecheck, test, build**

Run: `pnpm --filter @secretary/pwa typecheck` → exit 0.
Run: `pnpm --filter @secretary/pwa test` → all PASS (timeAgo, DiffView, DraftPanel, NeedsAttentionCard, + the foundation's client/session/events/BottomNav).
Run: `pnpm --filter @secretary/pwa build` → exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/service/pwa/src/routes/ThreadView.tsx
git commit -F - <<'MSG'
feat(pwa): thread/draft-review screen (generate/regenerate/edit/send/discard)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 10: BRIEF.md — deviations note

**Files:** Modify `BRIEF.md`.

- [ ] **Step 1: Append a note to the §12 PWA design subsection**

In `BRIEF.md`, at the end of the "### Draft review screen" subsection (or the §12 IA list), add:

```markdown
**Implementation note (designed screens, 2026-05-31):** The Needs Attention + draft-review screens were built on the Phase-2.5 foundation. Two deliberate deviations from this section: (1) **Send confirmation is a tap-to-confirm bottom sheet**, not a long-press → modal (long-press is awkward/uncommon on desktop and easy to mis-trigger; the sheet gives the same protection cross-platform). (2) **Swipe gestures** (handle-manually / snooze) and **voice input** (SpeechRecognition for raw intent) are **deferred** to a later polish pass. The screens consume two new API fields — `currentDraft` + `senderName` on `GET /threads/:id`, and `hasDraft` + `senderName` on needs-attention items.
```

- [ ] **Step 2: Commit**

```bash
git add BRIEF.md
git commit -F - <<'MSG'
docs(brief): record designed-screens deviations (tap-confirm; swipe/voice deferred)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 11: Manual verification runbook

**Files:** Create `docs/PHASE-2.5b-MANUAL-VERIFICATION.md`.

- [ ] **Step 1: Write the runbook**

````markdown
# PWA Designed Screens — Manual Verification

Automated tests cover the server enrichments (`app.inject`) and the pure client bits (`formatTimeAgo`, `DiffView`, card, draft panel). The screens are verified here. PowerShell from `C:\Users\drice\Secretary`. Prereqs: service on the Node-ABI build; the operator gateway + Ollama **up** (drafting needs the LLM).

## Setup

```powershell
# Terminal A — service (HTTPS API on 47824)
pnpm --filter @secretary/service dev:server
# Terminal B — PWA dev server (proxies /api/v1 + SSE)
pnpm --filter @secretary/pwa dev
```

Open http://localhost:5173, connect with the bootstrap token (`~/.secretary/bootstrap-token.txt`).

## Needs Attention

- Cards show **sender name**, time-ago, urgency pill, subject, agent summary.
- A thread with a draft shows **"Review draft ▸"**; one without shows **"Generate draft"**.
- Tap **Generate draft** on a card → spinner → routes into the thread with the new draft (gateway must be up).
- Tapping a card body opens the thread.

## Thread / draft review

- Conversation renders; the latest inbound message is expanded, others collapse/expand on tap.
- The draft editor shows the body (editable) + version + intent line.
- **Diff**: tap "diff" → shows the polish diff (added green / removed red); it's greyed when the draft had no raw intent.
- **Edit intent**: tap "Edit intent" → type an intent → "Regenerate" → a new version replaces the body.
- **Regenerate**: makes a new version from the last intent.
- **Edit + Send**: change the textarea, tap **Send** → confirm sheet → confirm → the edited text is what sends; you return to Needs Attention and the card is gone (thread → awaiting_their_reply).
- **Send failure** (stop the gateway/provider, or use a disconnected account): error banner, draft stays, thread unchanged.
- **Discard**: removes the draft → the screen returns to the "Generate draft" state.

## Live (SSE)

- With Needs Attention open, generate/regenerate/send from another path (or the thread screen) → the list updates without a manual reload.

## Production serve (optional)

- `pnpm --filter @secretary/pwa build`; run the compiled server (`node apps/service/dist/server/index.js`); open https://localhost:47824 and repeat the core flow.

## Acceptance

- Cards (sender-led, draft affordance) ✅; thread/draft review with generate/regenerate/edit/diff/send-confirm/discard ✅; live SSE refresh ✅.
````

- [ ] **Step 2: Commit**

```bash
git add docs/PHASE-2.5b-MANUAL-VERIFICATION.md
git commit -F - <<'MSG'
docs: manual verification runbook for the designed PWA screens

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 12: Full-green sweep

**Files:** none (verification + fixups).

- [ ] **Step 1: Whole-workspace tests + typecheck**

Run: `pnpm -r test` → all packages green (service incl. the new enrichment tests; `@secretary/pwa` incl. timeAgo/DiffView/DraftPanel/NeedsAttentionCard + the foundation suite).
Run: `pnpm -r typecheck` → exit 0.

- [ ] **Step 2: Lint + builds**

Run: `pnpm lint` (root `eslint .`) → exit 0 (PWA src is scoped out via `.eslintignore` from the foundation; the new service code must lint clean — fix any issues properly).
Run: `pnpm --filter @secretary/pwa build` and `pnpm --filter @secretary/service build` → both exit 0.

- [ ] **Step 3: Format**

Run `pnpm format`; confirm `pnpm format:check` → exit 0. If any source reformats, re-run `pnpm -r test`.

- [ ] **Step 4: Commit fixups (skip if none)**

```bash
git add -A
git commit -F - <<'MSG'
chore: lint/format fixups for the designed PWA screens

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

## Notes for the implementer

- **`@secretary/shared-types` is consumed as a built package** — after editing `domain.ts` (Task 1), run its `build` so the service + PWA typecheck against the new fields. If the service/PWA still don't see the fields, rebuild shared-types and re-run.
- **Do not run `pnpm dev`** (Electron tray, wrong ABI). Service tests + `dev:server` use the Node ABI (current state).
- **UI is manually verified** (BRIEF §18) — the render tests added here (card, DiffView, DraftPanel) are light guards on logic/branching, not full-screen tests. Don't add brittle network-dependent screen tests.
- **Drafting needs the gateway/Ollama** — Generate/Regenerate call the live LLM; the manual runbook notes this. The server enrichment tests don't need the gateway (they seed drafts directly).
