# Phase 3 — Generic IMAP Provider — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a generic IMAP `EmailProvider` (for Proton-via-Bridge and any IMAP server, verified now against Gmail) that syncs mail into the encrypted DB, watches for new mail live, and sends replies — all driven through the accounts/threads HTTP API.

**Architecture:** A provider layer (`EmailProvider` interface + `ImapProvider` over `imapflow`/`nodemailer`/`mailparser` + a `ProviderRegistry`), pure logic for threading + normalization, just-in-time repositories for messages/threads/contacts/action_log, a `SyncManager` that orchestrates fetch→persist→watch, and accounts/threads/send API routes. The real IMAP/SMTP I/O lives only in `ImapProvider` (manually verified); everything else is unit-tested with a `FakeEmailProvider` and fixtures.

**Tech Stack:** TypeScript (ESM/NodeNext, strict), `imapflow`, `nodemailer`, `mailparser`, `better-sqlite3-multiple-ciphers`, Fastify 5, zod, vitest.

**Spec:** `docs/superpowers/specs/2026-05-30-phase-3-imap-provider-design.md`

---

## Conventions (apply to every task)

- ESM: local imports use `.js`; workspace packages by name. TS strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`.
- `better-sqlite3-multiple-ciphers` type: `import type Database from '...'` then `Database.Database` (named type import is invalid for this `export =` package).
- Repository tests open a temp encrypted DB via `openDatabase(path, new InMemorySecretStore())` and **close it before `rmSync`** (Windows EBUSY); capture asserted values before `db.close()`.
- Errors are `SecretaryError` subclasses from `@secretary/shared-types`.
- After editing `packages/shared-types`, rebuild it (`pnpm --filter @secretary/shared-types build`) so `apps/service` resolves the new types from `dist`.
- Conventional commits; commit after each task. Append `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Branch: `feat/phase-3-imap-provider` (already checked out). Run commands from repo root.
- Run a single service test: `pnpm --filter @secretary/service exec vitest run test/<file>.test.ts`.

## File responsibility map

| File                                                         | Responsibility                                            |
| ------------------------------------------------------------ | --------------------------------------------------------- |
| `packages/shared-types/src/domain.ts`                        | `RawMessage`, `SendInput`, enums, API view types          |
| `packages/shared-types/src/errors.ts`                        | + `ImapError`                                             |
| `apps/service/server/db/schema.ts`                           | + `MessageRow`, `ThreadRow`, `ContactRow`, `ActionLogRow` |
| `apps/service/server/sync/threading.ts`                      | pure: `normalizeSubject`, `resolveThreadId`               |
| `apps/service/server/sync/normalize.ts`                      | pure: snippet, participants, JSON helpers                 |
| `apps/service/server/db/repositories/ContactsRepository.ts`  | contacts upsert/bump                                      |
| `apps/service/server/db/repositories/ThreadsRepository.ts`   | thread upsert/find/aggregate/list/get                     |
| `apps/service/server/db/repositories/MessagesRepository.ts`  | message insert/list/dedup                                 |
| `apps/service/server/db/repositories/ActionLogRepository.ts` | append action-log rows                                    |
| `apps/service/server/providers/ProviderInterface.ts`         | `EmailProvider` interface + `ImapConfig`                  |
| `apps/service/server/providers/imapConfig.ts`                | `AccountRow` → `ImapConfig` (loopback TLS)                |
| `apps/service/server/providers/ImapProvider.ts`              | imapflow/nodemailer/mailparser impl (manually verified)   |
| `apps/service/server/providers/ProviderRegistry.ts`          | live provider per account                                 |
| `apps/service/server/sync/SyncManager.ts`                    | fetch→persist→watch orchestration                         |
| `apps/service/server/api/accounts.ts`                        | account add/list/delete/resync + send                     |
| `apps/service/server/api/threads.ts`                         | thread list + detail                                      |
| `apps/service/server/server.ts` + `index.ts` + test helper   | wiring                                                    |
| `apps/service/test/helpers/fakeProvider.ts`                  | `FakeEmailProvider` for tests                             |
| `docs/PHASE-3-MANUAL-VERIFICATION.md`                        | Gmail/Proton manual runbook                               |

---

## Task 1: Dependencies + domain types + ImapError

**Files:**

- Modify: `apps/service/package.json` (deps)
- Create: `packages/shared-types/src/domain.ts`
- Modify: `packages/shared-types/src/index.ts`, `packages/shared-types/src/errors.ts`
- Test: `packages/shared-types/src/domain.test.ts`

- [ ] **Step 1: Add dependencies**

Run:

```
pnpm --filter @secretary/service add imapflow nodemailer mailparser
pnpm --filter @secretary/service add -D @types/nodemailer
```

(`imapflow` and `mailparser` ship their own types.) Expected: installs cleanly, no native build prompts.

- [ ] **Step 2: Write the failing test** `packages/shared-types/src/domain.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import type { RawMessage, SendInput } from './domain.js';

describe('domain types', () => {
  it('constructs a RawMessage and SendInput (compile + shape check)', () => {
    const raw: RawMessage = {
      providerId: 'u1',
      references: [],
      from: { address: 'a@b.com' },
      to: [{ address: 'c@d.com' }],
      cc: [],
      bcc: [],
      direction: 'inbound',
      isRead: false,
      isStarred: false,
      folder: 'INBOX',
      labels: [],
      attachmentsMeta: [],
    };
    const send: SendInput = { to: [{ address: 'c@d.com' }], bodyText: 'hi' };
    expect(raw.from.address).toBe('a@b.com');
    expect(send.bodyText).toBe('hi');
  });
});
```

- [ ] **Step 3: Run test, verify it FAILS** (cannot find `./domain.js`):
      `pnpm --filter @secretary/shared-types exec vitest run src/domain.test.ts`

- [ ] **Step 4: Create `packages/shared-types/src/domain.ts`**

```ts
export type Provider = 'imap' | 'gmail' | 'graph';
export type MessageDirection = 'inbound' | 'outbound';
export type ThreadState =
  | 'needs_classification'
  | 'awaiting_their_reply'
  | 'awaiting_your_reply'
  | 'closed'
  | 'scheduled_followup'
  | 'informational';
export type ContactCategory =
  | 'client_established'
  | 'client_new'
  | 'screening'
  | 'personal'
  | 'vendor'
  | 'noise'
  | 'unknown';
export type Urgency = 'low' | 'normal' | 'high';

export interface EmailAddress {
  address: string;
  name?: string;
}

export interface AttachmentMeta {
  filename: string;
  size: number;
  contentType: string;
  providerId?: string;
}

/** Provider-agnostic normalized message produced by every EmailProvider. */
export interface RawMessage {
  providerId: string;
  messageIdHeader?: string;
  inReplyTo?: string;
  references: string[];
  from: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  subject?: string;
  bodyText?: string;
  bodyHtml?: string;
  snippet?: string;
  direction: MessageDirection;
  dateSent?: number;
  dateReceived?: number;
  isRead: boolean;
  isStarred: boolean;
  folder: string;
  labels: string[];
  attachmentsMeta: AttachmentMeta[];
  rawSizeBytes?: number;
}

export interface SendInput {
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject?: string;
  bodyText: string;
  bodyHtml?: string;
  inReplyToMessageId?: string;
}

/** API view shapes (dates are ISO-8601 strings per BRIEF §16). */
export interface AccountView {
  id: string;
  provider: Provider;
  displayName: string;
  emailAddress: string;
  isEnabled: boolean;
  lastSyncedAt: string | null;
  syncState: string | null;
}

export interface MessageView {
  id: string;
  from: EmailAddress;
  to: EmailAddress[];
  subject: string | null;
  snippet: string | null;
  bodyText: string | null;
  direction: MessageDirection;
  dateReceived: string | null;
  isRead: boolean;
}

export interface ThreadSummary {
  id: string;
  accountId: string;
  subject: string | null;
  participants: string[];
  messageCount: number;
  lastMessageAt: string | null;
  state: ThreadState;
}

export interface ThreadWithMessages extends ThreadSummary {
  messages: MessageView[];
}
```

- [ ] **Step 5: Append `ImapError` to `packages/shared-types/src/errors.ts`** (after `UpstreamError`):

```ts
export class ImapError extends SecretaryError {
  constructor(message = 'IMAP connection failed') {
    super('imap_connection_failed', message, 400);
  }
}
```

- [ ] **Step 6: Update `packages/shared-types/src/index.ts`**

```ts
export * from './errors.js';
export * from './domain.js';
```

- [ ] **Step 7: Build shared-types, run test, typecheck**

Run: `pnpm --filter @secretary/shared-types build`
Run: `pnpm --filter @secretary/shared-types exec vitest run src/domain.test.ts` → PASS
Run: `pnpm --filter @secretary/shared-types typecheck` → clean

- [ ] **Step 8: Commit**

```
git add packages/shared-types apps/service/package.json pnpm-lock.yaml
git commit -m "feat(shared-types): add email domain types + ImapError; add imap deps"
```

---

## Task 2: DB row types for messages/threads/contacts/action_log

**Files:**

- Modify: `apps/service/server/db/schema.ts`
- Test: `apps/service/test/schema-rows.test.ts`

- [ ] **Step 1: Write the failing test** `apps/service/test/schema-rows.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import type { MessageRow, ThreadRow, ContactRow, ActionLogRow } from '../server/db/schema.js';

describe('new schema row types', () => {
  it('compile-checks the row shapes', () => {
    const t: Pick<ThreadRow, 'id' | 'state'> = { id: 't1', state: 'needs_classification' };
    const m: Pick<MessageRow, 'id' | 'direction'> = { id: 'm1', direction: 'inbound' };
    const c: Pick<ContactRow, 'id' | 'category'> = { id: 'c1', category: 'unknown' };
    const a: Pick<ActionLogRow, 'id' | 'actor'> = { id: 'a1', actor: 'system' };
    expect([t.state, m.direction, c.category, a.actor]).toEqual([
      'needs_classification',
      'inbound',
      'unknown',
      'system',
    ]);
  });
});
```

- [ ] **Step 2: Run test, verify it FAILS** (types not exported):
      `pnpm --filter @secretary/service exec vitest run test/schema-rows.test.ts`

- [ ] **Step 3: Append to `apps/service/server/db/schema.ts`** (replace the trailing comment block with these types):

```ts
export interface ThreadRow {
  id: string;
  account_id: string;
  provider_thread_id: string | null;
  subject_normalized: string | null;
  participants: string | null;
  message_count: number;
  first_message_at: number | null;
  last_message_at: number | null;
  last_inbound_at: number | null;
  last_outbound_at: number | null;
  state:
    | 'needs_classification'
    | 'awaiting_their_reply'
    | 'awaiting_your_reply'
    | 'closed'
    | 'scheduled_followup'
    | 'informational';
  state_changed_at: number | null;
  state_reason: string | null;
  sla_deadline: number | null;
  urgency: 'low' | 'normal' | 'high' | null;
  last_agent_summary: string | null;
  is_archived: number;
}

export interface MessageRow {
  id: string;
  account_id: string;
  provider_id: string;
  thread_id: string;
  message_id_header: string | null;
  in_reply_to: string | null;
  references_header: string | null;
  from_address: string;
  from_name: string | null;
  to_addresses: string | null;
  cc_addresses: string | null;
  bcc_addresses: string | null;
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
  snippet: string | null;
  direction: 'inbound' | 'outbound';
  date_sent: number | null;
  date_received: number | null;
  is_read: number | null;
  is_starred: number | null;
  is_draft: number | null;
  folder: string | null;
  labels: string | null;
  attachments_meta: string | null;
  raw_size_bytes: number | null;
  synced_at: number | null;
}

export interface ContactRow {
  id: string;
  email_address: string;
  display_name: string | null;
  aliases: string | null;
  category:
    | 'client_established'
    | 'client_new'
    | 'screening'
    | 'personal'
    | 'vendor'
    | 'noise'
    | 'unknown';
  notes: string | null;
  first_contact_at: number | null;
  last_contact_at: number | null;
  total_messages_in: number;
  total_messages_out: number;
  style_notes: string | null;
  do_not_auto_draft: number;
  screening_status: string | null;
  booking_history: string | null;
}

export interface ActionLogRow {
  id: string;
  timestamp: number;
  actor: 'agent' | 'user' | 'system';
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: string | null;
}
```

- [ ] **Step 4: Run test → PASS; typecheck clean.**

- [ ] **Step 5: Commit**

```
git add apps/service/server/db/schema.ts apps/service/test/schema-rows.test.ts
git commit -m "feat(service): add message/thread/contact/action_log row types"
```

---

## Task 3: Threading logic (pure)

**Files:**

- Create: `apps/service/server/sync/threading.ts`
- Test: `apps/service/test/threading.test.ts`

- [ ] **Step 1: Write the failing test** `apps/service/test/threading.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { normalizeSubject, resolveThreadId, type ThreadLookups } from '../server/sync/threading.js';

describe('normalizeSubject', () => {
  it('strips Re/Fwd prefixes and lowercases', () => {
    expect(normalizeSubject('Re: Fwd: Hello World')).toBe('hello world');
    expect(normalizeSubject(undefined)).toBe('');
  });
});

describe('resolveThreadId', () => {
  const base = { references: [] as string[], subject: 'Hello' };
  it('matches an existing thread by reply-chain message ids', () => {
    const lookups: ThreadLookups = {
      threadIdForMessageIds: (ids) => (ids.includes('<a@x>') ? 'T1' : undefined),
      threadIdForSubject: () => undefined,
    };
    expect(resolveThreadId({ ...base, inReplyTo: '<a@x>' }, lookups)).toBe('T1');
  });

  it('falls back to normalized subject', () => {
    const lookups: ThreadLookups = {
      threadIdForMessageIds: () => undefined,
      threadIdForSubject: (s) => (s === 'hello' ? 'T2' : undefined),
    };
    expect(resolveThreadId(base, lookups)).toBe('T2');
  });

  it('returns null when nothing matches (caller creates a new thread)', () => {
    const lookups: ThreadLookups = {
      threadIdForMessageIds: () => undefined,
      threadIdForSubject: () => undefined,
    };
    expect(resolveThreadId(base, lookups)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test, verify it FAILS** (module not found).

- [ ] **Step 3: Create `apps/service/server/sync/threading.ts`**

```ts
export interface ThreadLookups {
  /** Returns the thread id whose messages include any of these Message-IDs, else undefined. */
  threadIdForMessageIds(messageIds: string[]): string | undefined;
  /** Returns the thread id with this normalized subject (most recent), else undefined. */
  threadIdForSubject(subjectNormalized: string): string | undefined;
}

const PREFIX_RE = /^(\s*(re|fwd|fw)\s*:\s*)+/i;

export function normalizeSubject(subject: string | undefined): string {
  return (subject ?? '').replace(PREFIX_RE, '').trim().toLowerCase();
}

export interface ThreadCandidate {
  inReplyTo?: string;
  references: string[];
  subject?: string;
}

/**
 * Resolves which existing thread a message belongs to: first by reply-chain
 * (In-Reply-To / References matching a known Message-ID), then by normalized
 * subject. Returns null when no existing thread matches (caller creates one).
 */
export function resolveThreadId(msg: ThreadCandidate, lookups: ThreadLookups): string | null {
  const refIds = [msg.inReplyTo, ...msg.references].filter((x): x is string => Boolean(x));
  if (refIds.length > 0) {
    const byRef = lookups.threadIdForMessageIds(refIds);
    if (byRef) return byRef;
  }
  const subj = normalizeSubject(msg.subject);
  if (subj) {
    const bySubj = lookups.threadIdForSubject(subj);
    if (bySubj) return bySubj;
  }
  return null;
}
```

- [ ] **Step 4: Run test → PASS (4 tests).**

- [ ] **Step 5: Commit**

```
git add apps/service/server/sync/threading.ts apps/service/test/threading.test.ts
git commit -m "feat(service): add pure threading resolution (reply-chain + subject)"
```

---

## Task 4: Normalization helpers (pure)

**Files:**

- Create: `apps/service/server/sync/normalize.ts`
- Test: `apps/service/test/normalize.test.ts`

- [ ] **Step 1: Write the failing test** `apps/service/test/normalize.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { snippetOf, participantsOf } from '../server/sync/normalize.js';
import type { RawMessage } from '@secretary/shared-types';

const raw: RawMessage = {
  providerId: 'u1',
  references: [],
  from: { address: 'Alice@Example.com', name: 'Alice' },
  to: [{ address: 'bob@example.com' }],
  cc: [{ address: 'carol@example.com' }],
  bcc: [],
  subject: 'Hi',
  bodyText: '  Hello there, this is a long body. '.repeat(20),
  direction: 'inbound',
  isRead: false,
  isStarred: false,
  folder: 'INBOX',
  labels: [],
  attachmentsMeta: [],
};

describe('snippetOf', () => {
  it('trims and caps to 200 chars', () => {
    const s = snippetOf(raw.bodyText);
    expect(s.length).toBeLessThanOrEqual(200);
    expect(s.startsWith('Hello there')).toBe(true);
  });
  it('handles missing body', () => {
    expect(snippetOf(undefined)).toBe('');
  });
});

describe('participantsOf', () => {
  it('collects unique lowercased addresses from from/to/cc', () => {
    expect(participantsOf(raw).sort()).toEqual(
      ['alice@example.com', 'bob@example.com', 'carol@example.com'].sort(),
    );
  });
});
```

- [ ] **Step 2: Run test, verify it FAILS.**

- [ ] **Step 3: Create `apps/service/server/sync/normalize.ts`**

```ts
import type { RawMessage } from '@secretary/shared-types';

const SNIPPET_MAX = 200;

export function snippetOf(bodyText: string | undefined): string {
  if (!bodyText) return '';
  return bodyText.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_MAX);
}

/** Unique, lowercased participant addresses across from/to/cc (excludes bcc). */
export function participantsOf(raw: RawMessage): string[] {
  const all = [raw.from, ...raw.to, ...raw.cc].map((a) => a.address.toLowerCase());
  return [...new Set(all)];
}
```

- [ ] **Step 4: Run test → PASS; typecheck clean.**

- [ ] **Step 5: Commit**

```
git add apps/service/server/sync/normalize.ts apps/service/test/normalize.test.ts
git commit -m "feat(service): add pure normalization helpers (snippet, participants)"
```

---

## Task 5: ContactsRepository

**Files:**

- Create: `apps/service/server/db/repositories/ContactsRepository.ts`
- Test: `apps/service/test/contacts-repository.test.ts`

- [ ] **Step 1: Write the failing test** `apps/service/test/contacts-repository.test.ts`

```ts
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
```

- [ ] **Step 2: Run test, verify it FAILS.**

- [ ] **Step 3: Create `apps/service/server/db/repositories/ContactsRepository.ts`**

```ts
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3-multiple-ciphers';
import type { EmailAddress, MessageDirection } from '@secretary/shared-types';
import type { ContactRow } from '../schema.js';

export class ContactsRepository {
  constructor(private readonly db: Database.Database) {}

  findByEmail(email: string): ContactRow | undefined {
    return this.db
      .prepare('SELECT * FROM contacts WHERE email_address = ? COLLATE NOCASE')
      .get(email) as ContactRow | undefined;
  }

  /** Inserts the contact if new, then bumps the in/out counter and last_contact_at. */
  recordSeen(addr: EmailAddress, direction: MessageDirection, whenMs: number): void {
    const existing = this.findByEmail(addr.address);
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO contacts (id, email_address, display_name, category, first_contact_at, last_contact_at, total_messages_in, total_messages_out, do_not_auto_draft)
           VALUES (?, ?, ?, 'unknown', ?, ?, 0, 0, 0)`,
        )
        .run(randomUUID(), addr.address, addr.name ?? null, whenMs, whenMs);
    }
    const col = direction === 'inbound' ? 'total_messages_in' : 'total_messages_out';
    this.db
      .prepare(
        `UPDATE contacts SET ${col} = ${col} + 1,
           last_contact_at = MAX(COALESCE(last_contact_at, 0), ?)
         WHERE email_address = ? COLLATE NOCASE`,
      )
      .run(whenMs, addr.address);
  }
}
```

- [ ] **Step 4: Run test → PASS.**

- [ ] **Step 5: Commit**

```
git add apps/service/server/db/repositories/ContactsRepository.ts apps/service/test/contacts-repository.test.ts
git commit -m "feat(service): add ContactsRepository (case-insensitive upsert + counts)"
```

---

## Task 6: ThreadsRepository

**Files:**

- Create: `apps/service/server/db/repositories/ThreadsRepository.ts`
- Test: `apps/service/test/threads-repository.test.ts`

- [ ] **Step 1: Write the failing test** `apps/service/test/threads-repository.test.ts`

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemorySecretStore } from '../server/auth/SecretStore.js';
import { openDatabase } from '../server/db/connection.js';
import { ThreadsRepository } from '../server/db/repositories/ThreadsRepository.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secretary-threads-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function withAccount(db: ReturnType<typeof openDatabase>) {
  db.prepare(
    `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','a@b.com')`,
  ).run();
}

describe('ThreadsRepository', () => {
  it('creates a thread and finds it by normalized subject', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    withAccount(db);
    const repo = new ThreadsRepository(db);
    const id = repo.create('acc1', 'hello world', ['a@b.com'], 1000);
    const found = repo.threadIdForSubject('acc1', 'hello world');
    db.close();
    expect(found).toBe(id);
  });

  it('lists threads for an account ordered by last_message_at desc', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    withAccount(db);
    const repo = new ThreadsRepository(db);
    const a = repo.create('acc1', 'older', [], 1000);
    const b = repo.create('acc1', 'newer', [], 2000);
    repo.touch(a, { lastMessageAt: 1000 });
    repo.touch(b, { lastMessageAt: 2000 });
    const list = repo.listByAccount('acc1', 10, 0);
    db.close();
    expect(list.map((t) => t.id)).toEqual([b, a]);
  });
});
```

- [ ] **Step 2: Run test, verify it FAILS.**

- [ ] **Step 3: Create `apps/service/server/db/repositories/ThreadsRepository.ts`**

```ts
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3-multiple-ciphers';
import type { ThreadRow } from '../schema.js';

export interface ThreadTouch {
  lastMessageAt?: number;
  lastInboundAt?: number;
  lastOutboundAt?: number;
}

export class ThreadsRepository {
  constructor(private readonly db: Database.Database) {}

  create(
    accountId: string,
    subjectNormalized: string,
    participants: string[],
    whenMs: number,
  ): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO threads (id, account_id, subject_normalized, participants, message_count, first_message_at, last_message_at, state, state_changed_at)
         VALUES (?, ?, ?, ?, 0, ?, ?, 'needs_classification', ?)`,
      )
      .run(id, accountId, subjectNormalized, JSON.stringify(participants), whenMs, whenMs, whenMs);
    return id;
  }

  threadIdForSubject(accountId: string, subjectNormalized: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT id FROM threads WHERE account_id = ? AND subject_normalized = ?
         ORDER BY last_message_at DESC LIMIT 1`,
      )
      .get(accountId, subjectNormalized) as { id: string } | undefined;
    return row?.id;
  }

  /** Thread id containing any message whose Message-ID header is in the list. */
  threadIdForMessageIds(accountId: string, messageIds: string[]): string | undefined {
    if (messageIds.length === 0) return undefined;
    const placeholders = messageIds.map(() => '?').join(',');
    const row = this.db
      .prepare(
        `SELECT thread_id AS id FROM messages
         WHERE account_id = ? AND message_id_header IN (${placeholders}) LIMIT 1`,
      )
      .get(accountId, ...messageIds) as { id: string } | undefined;
    return row?.id;
  }

  touch(id: string, t: ThreadTouch): void {
    this.db
      .prepare(
        `UPDATE threads SET
           message_count = message_count + 1,
           last_message_at = MAX(COALESCE(last_message_at,0), COALESCE(?, last_message_at, 0)),
           last_inbound_at = MAX(COALESCE(last_inbound_at,0), COALESCE(?, last_inbound_at, 0)),
           last_outbound_at = MAX(COALESCE(last_outbound_at,0), COALESCE(?, last_outbound_at, 0))
         WHERE id = ?`,
      )
      .run(t.lastMessageAt ?? null, t.lastInboundAt ?? null, t.lastOutboundAt ?? null, id);
  }

  get(id: string): ThreadRow | undefined {
    return this.db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as ThreadRow | undefined;
  }

  listByAccount(accountId: string, limit: number, offset: number): ThreadRow[] {
    return this.db
      .prepare(
        `SELECT * FROM threads WHERE account_id = ?
         ORDER BY last_message_at DESC LIMIT ? OFFSET ?`,
      )
      .all(accountId, limit, offset) as ThreadRow[];
  }
}
```

> Note: `touch` increments `message_count` per call — the SyncManager calls it once per persisted message.

- [ ] **Step 4: Run test → PASS.**

- [ ] **Step 5: Commit**

```
git add apps/service/server/db/repositories/ThreadsRepository.ts apps/service/test/threads-repository.test.ts
git commit -m "feat(service): add ThreadsRepository (create/find/touch/list)"
```

---

## Task 7: MessagesRepository

**Files:**

- Create: `apps/service/server/db/repositories/MessagesRepository.ts`
- Test: `apps/service/test/messages-repository.test.ts`

- [ ] **Step 1: Write the failing test** `apps/service/test/messages-repository.test.ts`

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemorySecretStore } from '../server/auth/SecretStore.js';
import { openDatabase } from '../server/db/connection.js';
import { MessagesRepository } from '../server/db/repositories/MessagesRepository.js';
import type { RawMessage } from '@secretary/shared-types';

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
```

- [ ] **Step 2: Run test, verify it FAILS.**

- [ ] **Step 3: Create `apps/service/server/db/repositories/MessagesRepository.ts`**

```ts
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3-multiple-ciphers';
import type { RawMessage } from '@secretary/shared-types';
import type { MessageRow } from '../schema.js';

export class MessagesRepository {
  constructor(private readonly db: Database.Database) {}

  /** Inserts a message; returns false (no-op) if (account_id, provider_id) already exists. */
  insert(accountId: string, threadId: string, raw: RawMessage): boolean {
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
        randomUUID(),
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
    return info.changes > 0;
  }

  listByThread(threadId: string): MessageRow[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY COALESCE(date_received, 0) ASC')
      .all(threadId) as MessageRow[];
  }
}
```

- [ ] **Step 4: Run test → PASS.**

- [ ] **Step 5: Commit**

```
git add apps/service/server/db/repositories/MessagesRepository.ts apps/service/test/messages-repository.test.ts
git commit -m "feat(service): add MessagesRepository (idempotent insert, list by thread)"
```

---

## Task 8: ActionLogRepository

**Files:**

- Create: `apps/service/server/db/repositories/ActionLogRepository.ts`
- Test: `apps/service/test/action-log-repository.test.ts`

- [ ] **Step 1: Write the failing test** `apps/service/test/action-log-repository.test.ts`

```ts
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
    const n = (db.prepare('SELECT COUNT(*) AS n FROM action_log').get() as { n: number }).n;
    db.close();
    expect(n).toBe(1);
  });
});
```

- [ ] **Step 2: Run test, verify it FAILS.**

- [ ] **Step 3: Create `apps/service/server/db/repositories/ActionLogRepository.ts`**

```ts
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3-multiple-ciphers';

export interface ActionLogEntry {
  actor: 'agent' | 'user' | 'system';
  action: string;
  targetType?: string;
  targetId?: string;
  /** action-specific metadata — NEVER message bodies/prompts. */
  details?: Record<string, unknown>;
}

export class ActionLogRepository {
  constructor(private readonly db: Database.Database) {}

  append(entry: ActionLogEntry): void {
    this.db
      .prepare(
        `INSERT INTO action_log (id, timestamp, actor, action, target_type, target_id, details)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        Date.now(),
        entry.actor,
        entry.action,
        entry.targetType ?? null,
        entry.targetId ?? null,
        entry.details ? JSON.stringify(entry.details) : null,
      );
  }
}
```

- [ ] **Step 4: Run test → PASS.**

- [ ] **Step 5: Commit**

```
git add apps/service/server/db/repositories/ActionLogRepository.ts apps/service/test/action-log-repository.test.ts
git commit -m "feat(service): add ActionLogRepository (metadata-only append)"
```

---

## Task 9: EmailProvider interface + ImapConfig + FakeEmailProvider

**Files:**

- Create: `apps/service/server/providers/ProviderInterface.ts`
- Create: `apps/service/test/helpers/fakeProvider.ts`
- Test: `apps/service/test/fake-provider.test.ts`

- [ ] **Step 1: Write the failing test** `apps/service/test/fake-provider.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { FakeEmailProvider } from './helpers/fakeProvider.js';
import type { RawMessage } from '@secretary/shared-types';

const msg: RawMessage = {
  providerId: 'u1',
  references: [],
  from: { address: 'a@b.com' },
  to: [{ address: 'c@d.com' }],
  cc: [],
  bcc: [],
  direction: 'inbound',
  isRead: false,
  isStarred: false,
  folder: 'INBOX',
  labels: [],
  attachmentsMeta: [],
};

describe('FakeEmailProvider', () => {
  it('returns scripted messages from syncFull and fires the watcher', async () => {
    const p = new FakeEmailProvider('acc1', [msg]);
    expect(await p.syncFull(0)).toHaveLength(1);
    let fired = 0;
    await p.startWatching(() => {
      fired += 1;
    });
    p.emitChange();
    expect(fired).toBe(1);
    const sent = await p.sendMessage({ to: [{ address: 'c@d.com' }], bodyText: 'hi' });
    expect(sent.providerMessageId).toMatch(/^fake-/);
  });
});
```

- [ ] **Step 2: Run test, verify it FAILS** (modules not found).

- [ ] **Step 3: Create `apps/service/server/providers/ProviderInterface.ts`**

```ts
import type { RawMessage, SendInput } from '@secretary/shared-types';

export interface SyncResult {
  newMessages: RawMessage[];
  updatedMessages: RawMessage[];
  nextSyncState: Record<string, unknown>;
}

/** Provider-agnostic email backend contract (BRIEF §7). */
export interface EmailProvider {
  readonly accountId: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  syncIncremental(): Promise<SyncResult>;
  syncFull(sinceUnixMs: number): Promise<RawMessage[]>;
  startWatching(onChange: () => void): Promise<void>;
  stopWatching(): Promise<void>;
  sendMessage(input: SendInput): Promise<{ providerMessageId: string }>;
  markRead(providerMessageId: string, isRead: boolean): Promise<void>;
  moveToFolder?(providerMessageId: string, folder: string): Promise<void>;
  healthCheck(): Promise<{ ok: boolean; details?: string }>;
}

/** Resolved IMAP/SMTP connection config (built from an account row). */
export interface ImapConfig {
  accountId: string;
  imap: { host: string; port: number; secure: boolean; rejectUnauthorized: boolean };
  smtp: { host: string; port: number; secure: boolean; rejectUnauthorized: boolean };
  auth: { user: string; pass: string };
}
```

- [ ] **Step 4: Create `apps/service/test/helpers/fakeProvider.ts`**

```ts
import type { RawMessage, SendInput } from '@secretary/shared-types';
import type { EmailProvider, SyncResult } from '../../server/providers/ProviderInterface.js';

/** In-memory EmailProvider for unit-testing the SyncManager + routes without real IMAP. */
export class FakeEmailProvider implements EmailProvider {
  private connected = false;
  private onChange: (() => void) | null = null;
  private incremental: RawMessage[] = [];
  private sendCount = 0;

  constructor(
    public readonly accountId: string,
    private readonly fullMessages: RawMessage[] = [],
  ) {}

  setIncremental(messages: RawMessage[]): void {
    this.incremental = messages;
  }

  emitChange(): void {
    this.onChange?.();
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async syncFull(): Promise<RawMessage[]> {
    return this.fullMessages;
  }

  async syncIncremental(): Promise<SyncResult> {
    return { newMessages: this.incremental, updatedMessages: [], nextSyncState: { lastUid: 1 } };
  }

  async startWatching(onChange: () => void): Promise<void> {
    this.onChange = onChange;
  }

  async stopWatching(): Promise<void> {
    this.onChange = null;
  }

  async sendMessage(_input: SendInput): Promise<{ providerMessageId: string }> {
    this.sendCount += 1;
    return { providerMessageId: `fake-${this.sendCount}` };
  }

  async markRead(): Promise<void> {}

  async healthCheck(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
}
```

- [ ] **Step 5: Run test → PASS; typecheck clean.**

- [ ] **Step 6: Commit**

```
git add apps/service/server/providers/ProviderInterface.ts apps/service/test/helpers/fakeProvider.ts apps/service/test/fake-provider.test.ts
git commit -m "feat(service): add EmailProvider interface, ImapConfig, FakeEmailProvider"
```

---

## Task 10: ImapConfig builder

**Files:**

- Create: `apps/service/server/providers/imapConfig.ts`
- Test: `apps/service/test/imap-config.test.ts`

- [ ] **Step 1: Write the failing test** `apps/service/test/imap-config.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { buildImapConfig } from '../server/providers/imapConfig.js';
import type { AccountRow } from '../server/db/schema.js';

const base: AccountRow = {
  id: 'acc1',
  provider: 'imap',
  display_name: 'A',
  email_address: 'me@example.com',
  imap_host: 'imap.gmail.com',
  imap_port: 993,
  imap_use_tls: 1,
  smtp_host: 'smtp.gmail.com',
  smtp_port: 465,
  oauth_keychain_handle: null,
  imap_password_keychain_handle: 'imap.acc1',
  sync_state: null,
  is_enabled: 1,
  created_at: 0,
  last_synced_at: null,
};

describe('buildImapConfig', () => {
  it('uses secure TLS + verification for a remote host', () => {
    const cfg = buildImapConfig(base, 'me@example.com', 'pw');
    expect(cfg.imap.secure).toBe(true);
    expect(cfg.imap.rejectUnauthorized).toBe(true);
  });

  it('allows self-signed for a loopback host (Proton Bridge)', () => {
    const cfg = buildImapConfig(
      {
        ...base,
        imap_host: '127.0.0.1',
        imap_port: 1143,
        imap_use_tls: 0,
        smtp_host: '127.0.0.1',
        smtp_port: 1025,
      },
      'me@example.com',
      'pw',
    );
    expect(cfg.imap.secure).toBe(false);
    expect(cfg.imap.rejectUnauthorized).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, verify it FAILS.**

- [ ] **Step 3: Create `apps/service/server/providers/imapConfig.ts`**

```ts
import { ImapError } from '@secretary/shared-types';
import type { AccountRow } from '../db/schema.js';
import type { ImapConfig } from './ProviderInterface.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

function isLoopback(host: string): boolean {
  return LOOPBACK.has(host.toLowerCase());
}

/** Resolves an account row + password into a connection config. Loopback hosts
 * (Proton Bridge) use a non-secure/STARTTLS socket and accept the self-signed cert. */
export function buildImapConfig(account: AccountRow, user: string, pass: string): ImapConfig {
  if (!account.imap_host || account.imap_port === null) {
    throw new ImapError('IMAP host/port not configured');
  }
  const loop = isLoopback(account.imap_host);
  const smtpHost = account.smtp_host ?? account.imap_host;
  const smtpPort = account.smtp_port ?? 587;
  return {
    accountId: account.id,
    imap: {
      host: account.imap_host,
      port: account.imap_port,
      secure: account.imap_use_tls === 1,
      rejectUnauthorized: !loop,
    },
    smtp: {
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      rejectUnauthorized: !isLoopback(smtpHost),
    },
    auth: { user, pass },
  };
}
```

- [ ] **Step 4: Run test → PASS.**

- [ ] **Step 5: Commit**

```
git add apps/service/server/providers/imapConfig.ts apps/service/test/imap-config.test.ts
git commit -m "feat(service): add ImapConfig builder with loopback TLS handling"
```

---

## Task 11: ImapProvider (imapflow/nodemailer/mailparser) — reference impl, manually verified

**Files:**

- Create: `apps/service/server/providers/ImapProvider.ts`

This wraps the real libraries; it is **not unit-tested** (like `KeychainStore`) — it's exercised by the manual Gmail/Proton runbook (Task 18). It MUST typecheck. Adapt the library calls if the installed versions differ; report any signature you had to change.

- [ ] **Step 1: Create `apps/service/server/providers/ImapProvider.ts`**

```ts
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser, type AddressObject } from 'mailparser';
import type { EmailAddress, RawMessage, SendInput } from '@secretary/shared-types';
import { ImapError } from '@secretary/shared-types';
import type { EmailProvider, ImapConfig, SyncResult } from './ProviderInterface.js';
import { snippetOf } from '../sync/normalize.js';

const FOLDERS: Array<{ mailbox: string; direction: 'inbound' | 'outbound' }> = [
  { mailbox: 'INBOX', direction: 'inbound' },
  { mailbox: 'Sent', direction: 'outbound' },
];

function addrs(a: AddressObject | AddressObject[] | undefined): EmailAddress[] {
  if (!a) return [];
  const list = Array.isArray(a) ? a : [a];
  return list.flatMap((g) =>
    (g.value ?? [])
      .filter((v) => v.address)
      .map((v) =>
        v.name ? { address: v.address as string, name: v.name } : { address: v.address as string },
      ),
  );
}

export class ImapProvider implements EmailProvider {
  readonly accountId: string;
  private client: ImapFlow;
  private watching = false;

  constructor(private readonly config: ImapConfig) {
    this.accountId = config.accountId;
    this.client = new ImapFlow({
      host: config.imap.host,
      port: config.imap.port,
      secure: config.imap.secure,
      auth: { user: config.auth.user, pass: config.auth.pass },
      tls: { rejectUnauthorized: config.imap.rejectUnauthorized },
      logger: false,
    });
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async disconnect(): Promise<void> {
    try {
      await this.client.logout();
    } catch {
      /* ignore */
    }
  }

  isConnected(): boolean {
    return this.client.usable;
  }

  async healthCheck(): Promise<{ ok: boolean; details?: string }> {
    try {
      const c = new ImapFlow({
        host: this.config.imap.host,
        port: this.config.imap.port,
        secure: this.config.imap.secure,
        auth: { user: this.config.auth.user, pass: this.config.auth.pass },
        tls: { rejectUnauthorized: this.config.imap.rejectUnauthorized },
        logger: false,
      });
      await c.connect();
      await c.logout();
      return { ok: true };
    } catch (err) {
      return { ok: false, details: err instanceof Error ? err.message : 'connection failed' };
    }
  }

  async syncFull(sinceUnixMs: number): Promise<RawMessage[]> {
    const since = new Date(sinceUnixMs);
    const out: RawMessage[] = [];
    const seen = new Set<string>();
    for (const { mailbox, direction } of FOLDERS) {
      const lock = await this.client.getMailboxLock(mailbox).catch(() => null);
      if (!lock) continue; // folder may not exist (e.g. provider-specific Sent name)
      try {
        for await (const msg of this.client.fetch(
          { since },
          { uid: true, flags: true, internalDate: true, size: true, source: true },
        )) {
          const raw = await this.parse(msg, direction, mailbox);
          const dedupKey = raw.messageIdHeader ?? `${mailbox}:${raw.providerId}`;
          if (seen.has(dedupKey)) continue;
          seen.add(dedupKey);
          out.push(raw);
        }
      } finally {
        lock.release();
      }
    }
    return out;
  }

  async syncIncremental(): Promise<SyncResult> {
    // For v1, re-run a bounded full sync (last 2 days) and let idempotent inserts dedup.
    const newMessages = await this.syncFull(Date.now() - 2 * 24 * 60 * 60 * 1000);
    return { newMessages, updatedMessages: [], nextSyncState: { syncedAt: Date.now() } };
  }

  async startWatching(onChange: () => void): Promise<void> {
    if (this.watching) return;
    this.watching = true;
    await this.client.mailboxOpen('INBOX');
    this.client.on('exists', () => onChange());
    this.client.on('close', () => {
      this.watching = false;
    });
  }

  async stopWatching(): Promise<void> {
    this.watching = false;
  }

  async sendMessage(input: SendInput): Promise<{ providerMessageId: string }> {
    const transport = nodemailer.createTransport({
      host: this.config.smtp.host,
      port: this.config.smtp.port,
      secure: this.config.smtp.secure,
      auth: { user: this.config.auth.user, pass: this.config.auth.pass },
      tls: { rejectUnauthorized: this.config.smtp.rejectUnauthorized },
    });
    const info = await transport.sendMail({
      from: this.config.auth.user,
      to: input.to.map((a) => a.address),
      cc: input.cc?.map((a) => a.address),
      bcc: input.bcc?.map((a) => a.address),
      subject: input.subject ?? '',
      text: input.bodyText,
      html: input.bodyHtml,
      inReplyTo: input.inReplyToMessageId,
      references: input.inReplyToMessageId,
    });
    return { providerMessageId: info.messageId };
  }

  async markRead(providerMessageId: string, isRead: boolean): Promise<void> {
    await this.client.mailboxOpen('INBOX');
    if (isRead)
      await this.client.messageFlagsAdd({ uid: providerMessageId }, ['\\Seen'], { uid: true });
    else
      await this.client.messageFlagsRemove({ uid: providerMessageId }, ['\\Seen'], { uid: true });
  }

  private async parse(
    msg: { uid: number; flags?: Set<string>; size?: number; source: Buffer },
    direction: 'inbound' | 'outbound',
    folder: string,
  ): Promise<RawMessage> {
    const p = await simpleParser(msg.source);
    const refs = Array.isArray(p.references) ? p.references : p.references ? [p.references] : [];
    const flags = msg.flags ?? new Set<string>();
    const from = addrs(p.from)[0] ?? { address: 'unknown@unknown' };
    const text = p.text ?? undefined;
    if (!ImapError) throw new ImapError(); // (never thrown — keeps import referenced if needed)
    return {
      providerId: String(msg.uid),
      ...(p.messageId ? { messageIdHeader: p.messageId } : {}),
      ...(p.inReplyTo ? { inReplyTo: p.inReplyTo } : {}),
      references: refs,
      from,
      to: addrs(p.to),
      cc: addrs(p.cc),
      bcc: addrs(p.bcc),
      ...(p.subject ? { subject: p.subject } : {}),
      ...(text ? { bodyText: text } : {}),
      ...(p.html ? { bodyHtml: p.html } : {}),
      snippet: snippetOf(text),
      direction,
      ...(p.date ? { dateSent: p.date.getTime(), dateReceived: p.date.getTime() } : {}),
      isRead: flags.has('\\Seen'),
      isStarred: flags.has('\\Flagged'),
      folder,
      labels: [folder],
      attachmentsMeta: (p.attachments ?? []).map((a) => ({
        filename: a.filename ?? 'attachment',
        size: a.size,
        contentType: a.contentType,
      })),
      ...(msg.size ? { rawSizeBytes: msg.size } : {}),
    };
  }
}
```

> Remove the `if (!ImapError) throw new ImapError();` guard if `ImapError` ends up used elsewhere in the file; it's only there so the import isn't unused. Prefer deleting the import if truly unused. Adapt `messageFlagsAdd`/`fetch`/`simpleParser` field access to the installed library types as needed.

- [ ] **Step 2: Typecheck** `pnpm --filter @secretary/service typecheck` → must be clean. Fix any library-signature mismatches (and note them).

- [ ] **Step 3: Commit**

```
git add apps/service/server/providers/ImapProvider.ts
git commit -m "feat(service): add ImapProvider over imapflow/nodemailer/mailparser"
```

---

## Task 12: ProviderRegistry

**Files:**

- Create: `apps/service/server/providers/ProviderRegistry.ts`
- Test: `apps/service/test/provider-registry.test.ts`

- [ ] **Step 1: Write the failing test** `apps/service/test/provider-registry.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '../server/providers/ProviderRegistry.js';
import { FakeEmailProvider } from './helpers/fakeProvider.js';

describe('ProviderRegistry', () => {
  it('stores, retrieves, and removes providers by accountId', () => {
    const reg = new ProviderRegistry();
    const p = new FakeEmailProvider('acc1');
    reg.set(p);
    expect(reg.get('acc1')).toBe(p);
    expect(reg.get('nope')).toBeUndefined();
    reg.remove('acc1');
    expect(reg.get('acc1')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test, verify it FAILS.**

- [ ] **Step 3: Create `apps/service/server/providers/ProviderRegistry.ts`**

```ts
import type { EmailProvider } from './ProviderInterface.js';

/** Holds the live EmailProvider instance per account. */
export class ProviderRegistry {
  private readonly byAccount = new Map<string, EmailProvider>();

  set(provider: EmailProvider): void {
    this.byAccount.set(provider.accountId, provider);
  }

  get(accountId: string): EmailProvider | undefined {
    return this.byAccount.get(accountId);
  }

  remove(accountId: string): void {
    this.byAccount.delete(accountId);
  }

  all(): EmailProvider[] {
    return [...this.byAccount.values()];
  }
}
```

- [ ] **Step 4: Run test → PASS.**

- [ ] **Step 5: Commit**

```
git add apps/service/server/providers/ProviderRegistry.ts apps/service/test/provider-registry.test.ts
git commit -m "feat(service): add ProviderRegistry"
```

---

## Task 13: SyncManager (orchestration)

**Files:**

- Create: `apps/service/server/sync/SyncManager.ts`
- Test: `apps/service/test/sync-manager.test.ts`

- [ ] **Step 1: Write the failing test** `apps/service/test/sync-manager.test.ts`

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemorySecretStore } from '../server/auth/SecretStore.js';
import { openDatabase } from '../server/db/connection.js';
import { EventBus } from '../server/eventBus.js';
import { ProviderRegistry } from '../server/providers/ProviderRegistry.js';
import { SyncManager } from '../server/sync/SyncManager.js';
import { FakeEmailProvider } from './helpers/fakeProvider.js';
import type { RawMessage } from '@secretary/shared-types';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secretary-sync-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function inbound(uid: string, subject: string, inReplyTo?: string, messageId?: string): RawMessage {
  return {
    providerId: uid,
    references: [],
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(messageId ? { messageIdHeader: messageId } : {}),
    from: { address: 'alice@example.com', name: 'Alice' },
    to: [{ address: 'me@example.com' }],
    cc: [],
    bcc: [],
    subject,
    bodyText: 'hello',
    direction: 'inbound',
    dateReceived: Number(uid) * 1000,
    isRead: false,
    isStarred: false,
    folder: 'INBOX',
    labels: ['INBOX'],
    attachmentsMeta: [],
  };
}

describe('SyncManager.initialSync', () => {
  it('persists messages, reconstructs the thread, writes contacts + action log', async () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','Me','me@example.com')`,
    ).run();
    const registry = new ProviderRegistry();
    const provider = new FakeEmailProvider('acc1', [
      inbound('1', 'Project kickoff', undefined, '<m1@x>'),
      inbound('2', 'Re: Project kickoff', '<m1@x>'),
    ]);
    registry.set(provider);
    const sync = new SyncManager(db, registry, new EventBus());

    await sync.initialSync('acc1');

    const threads = db.prepare('SELECT COUNT(*) AS n FROM threads').get() as { n: number };
    const messages = db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number };
    const contacts = db.prepare('SELECT COUNT(*) AS n FROM contacts').get() as { n: number };
    const log = db.prepare('SELECT COUNT(*) AS n FROM action_log').get() as { n: number };
    db.close();
    expect(threads.n).toBe(1); // reply folded into the same thread
    expect(messages.n).toBe(2);
    expect(contacts.n).toBe(1);
    expect(log.n).toBe(2);
  });
});
```

- [ ] **Step 2: Run test, verify it FAILS.**

- [ ] **Step 3: Create `apps/service/server/sync/SyncManager.ts`**

```ts
import type Database from 'better-sqlite3-multiple-ciphers';
import type { RawMessage } from '@secretary/shared-types';
import type { EventBus } from '../eventBus.js';
import type { ProviderRegistry } from '../providers/ProviderRegistry.js';
import { ContactsRepository } from '../db/repositories/ContactsRepository.js';
import { ThreadsRepository } from '../db/repositories/ThreadsRepository.js';
import { MessagesRepository } from '../db/repositories/MessagesRepository.js';
import { ActionLogRepository } from '../db/repositories/ActionLogRepository.js';
import { resolveThreadId, normalizeSubject } from './threading.js';
import { participantsOf } from './normalize.js';

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

export class SyncManager {
  private readonly contacts: ContactsRepository;
  private readonly threads: ThreadsRepository;
  private readonly messages: MessagesRepository;
  private readonly actions: ActionLogRepository;

  constructor(
    private readonly db: Database.Database,
    private readonly registry: ProviderRegistry,
    private readonly eventBus: EventBus,
    private readonly now: () => number = Date.now,
  ) {
    this.contacts = new ContactsRepository(db);
    this.threads = new ThreadsRepository(db);
    this.messages = new MessagesRepository(db);
    this.actions = new ActionLogRepository(db);
  }

  /** First sync for an account: connect, fetch last 90 days, persist, then watch. */
  async initialSync(accountId: string): Promise<void> {
    const provider = this.registry.get(accountId);
    if (!provider) return;
    await provider.connect();
    const msgs = await provider.syncFull(this.now() - NINETY_DAYS_MS);
    for (const raw of msgs) this.persist(accountId, raw);
    this.markSynced(accountId);
    await provider.startWatching(() => {
      void this.incrementalSync(accountId);
    });
  }

  /** Pull just-arrived messages and persist them. */
  async incrementalSync(accountId: string): Promise<void> {
    const provider = this.registry.get(accountId);
    if (!provider) return;
    const { newMessages } = await provider.syncIncremental();
    for (const raw of newMessages) this.persist(accountId, raw);
    this.markSynced(accountId);
  }

  /** Persists one message (contact + thread + message + action log) in a transaction. */
  private persist(accountId: string, raw: RawMessage): void {
    const tx = this.db.transaction(() => {
      const when = raw.dateReceived ?? raw.dateSent ?? this.now();
      this.contacts.recordSeen(raw.from, raw.direction, when);

      const refIds = [raw.inReplyTo, ...raw.references].filter((x): x is string => Boolean(x));
      let threadId = resolveThreadId(
        {
          references: raw.references,
          ...(raw.inReplyTo ? { inReplyTo: raw.inReplyTo } : {}),
          ...(raw.subject ? { subject: raw.subject } : {}),
        },
        {
          threadIdForMessageIds: (ids) => this.threads.threadIdForMessageIds(accountId, ids),
          threadIdForSubject: (s) => this.threads.threadIdForSubject(accountId, s),
        },
      );
      void refIds;
      if (!threadId) {
        threadId = this.threads.create(
          accountId,
          normalizeSubject(raw.subject),
          participantsOf(raw),
          when,
        );
      }

      const inserted = this.messages.insert(accountId, threadId, raw);
      if (!inserted) return; // duplicate provider_id — skip aggregates + log

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
    });
    tx();
    this.eventBus.emit({ type: 'thread:updated', payload: { accountId } });
  }

  private markSynced(accountId: string): void {
    this.db
      .prepare('UPDATE accounts SET last_synced_at = ? WHERE id = ?')
      .run(this.now(), accountId);
  }
}
```

- [ ] **Step 4: Run test → PASS (1 thread, 2 messages, 1 contact, 2 log entries).**

- [ ] **Step 5: Commit**

```
git add apps/service/server/sync/SyncManager.ts apps/service/test/sync-manager.test.ts
git commit -m "feat(service): add SyncManager (fetch -> persist -> thread/contact/log)"
```

---

## Task 14: Accounts API (add IMAP, list, delete, resync)

**Files:**

- Create: `apps/service/server/api/accounts.ts`
- Modify: `apps/service/server/server.ts` (deps + registration)
- Test: `apps/service/test/accounts-routes.test.ts`

This task introduces a new `ServerDeps` shape (adds `providers`, `sync`, and a `secrets` store + a `providerFactory`). To keep `ImapProvider` (real IMAP) out of tests, the account-add route builds providers through an injected `providerFactory(account, user, pass)` so tests pass a factory returning a `FakeEmailProvider`.

- [ ] **Step 1: Extend `ServerDeps` and the test helper.**

In `apps/service/server/server.ts`, add imports + fields:

```ts
import type { ProviderRegistry } from './providers/ProviderRegistry.js';
import type { SyncManager } from './sync/SyncManager.js';
import type { SecretStore } from './auth/SecretStore.js';
import type { EmailProvider, ImapConfig } from './providers/ProviderInterface.js';
import type { AccountRow } from './db/schema.js';
```

Add to `ServerDeps`:

```ts
providers: ProviderRegistry;
sync: SyncManager;
secrets: SecretStore;
/** Builds a provider for a resolved config — injectable so tests use a fake. */
providerFactory: (config: ImapConfig) => EmailProvider;
```

Register accounts routes in the `/api/v1` block (after settings):

```ts
registerAccountsRoutes(api, deps);
```

and import `import { registerAccountsRoutes } from './api/accounts.js';`

Update `apps/service/test/helpers/testServer.ts` to construct + pass these:

```ts
import { ProviderRegistry } from '../../server/providers/ProviderRegistry.js';
import { SyncManager } from '../../server/sync/SyncManager.js';
import { FakeEmailProvider } from './fakeProvider.js';
// ...inside makeTestServer, after eventBus:
const providers = new ProviderRegistry();
const sync = new SyncManager(db, providers, eventBus);
const made: FakeEmailProvider[] = [];
const providerFactory = (config: { accountId: string }) => {
  const p = new FakeEmailProvider(config.accountId, []);
  made.push(p);
  return p;
};
const app = buildServer({
  db,
  sessions,
  eventBus,
  secrets: store,
  providers,
  sync,
  providerFactory,
  origin: 'https://localhost:47824',
  ...(opts.pwaDir ? { pwaDir: opts.pwaDir } : {}),
});
// add `providers, sync, made` to the returned object + the TestServer interface.
```

- [ ] **Step 2: Write the failing test** `apps/service/test/accounts-routes.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { makeTestServer } from './helpers/testServer.js';

const body = {
  displayName: 'Me',
  emailAddress: 'me@example.com',
  imapHost: 'imap.example.com',
  imapPort: 993,
  useTls: true,
  smtpHost: 'smtp.example.com',
  smtpPort: 465,
  password: 'secret',
};

describe('accounts routes', () => {
  it('adds an IMAP account (healthcheck passes), stores password, lists it', async () => {
    const { app, session, store } = await makeTestServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/accounts/imap',
      headers: { authorization: `Bearer ${session}` },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const id = res.json().data.id as string;
    expect(store.get(`imap.${id}`)).toBe('secret');

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/accounts',
      headers: { authorization: `Bearer ${session}` },
    });
    expect(list.json().data).toHaveLength(1);
    await app.close();
  });

  it('rejects unauthenticated', async () => {
    const { app } = await makeTestServer();
    const res = await app.inject({ method: 'GET', url: '/api/v1/accounts' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
```

- [ ] **Step 3: Run test, verify it FAILS** (route 404).

- [ ] **Step 4: Create `apps/service/server/api/accounts.ts`**

```ts
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3-multiple-ciphers';
import { z } from 'zod';
import { ImapError, ValidationError, type AccountView } from '@secretary/shared-types';
import type { SecretStore } from '../auth/SecretStore.js';
import type { ProviderRegistry } from '../providers/ProviderRegistry.js';
import type { SyncManager } from '../sync/SyncManager.js';
import type { EmailProvider, ImapConfig } from '../providers/ProviderInterface.js';
import type { AccountRow } from '../db/schema.js';
import { buildImapConfig } from '../providers/imapConfig.js';

const imapSchema = z.object({
  displayName: z.string().min(1),
  emailAddress: z.string().email(),
  imapHost: z.string().min(1),
  imapPort: z.number().int().positive(),
  useTls: z.boolean(),
  smtpHost: z.string().min(1),
  smtpPort: z.number().int().positive(),
  password: z.string().min(1),
});

export interface AccountsDeps {
  db: Database.Database;
  secrets: SecretStore;
  providers: ProviderRegistry;
  sync: SyncManager;
  providerFactory: (config: ImapConfig) => EmailProvider;
}

function toView(row: AccountRow): AccountView {
  return {
    id: row.id,
    provider: row.provider,
    displayName: row.display_name,
    emailAddress: row.email_address,
    isEnabled: row.is_enabled === 1,
    lastSyncedAt: row.last_synced_at ? new Date(row.last_synced_at).toISOString() : null,
    syncState: row.sync_state,
  };
}

export function registerAccountsRoutes(app: FastifyInstance, deps: AccountsDeps): void {
  app.post('/accounts/imap', async (req) => {
    const parsed = imapSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid IMAP account');
    const a = parsed.data;
    const id = randomUUID();
    const handle = `imap.${id}`;

    const account: AccountRow = {
      id,
      provider: 'imap',
      display_name: a.displayName,
      email_address: a.emailAddress,
      imap_host: a.imapHost,
      imap_port: a.imapPort,
      imap_use_tls: a.useTls ? 1 : 0,
      smtp_host: a.smtpHost,
      smtp_port: a.smtpPort,
      oauth_keychain_handle: null,
      imap_password_keychain_handle: handle,
      sync_state: 'syncing',
      is_enabled: 1,
      created_at: Date.now(),
      last_synced_at: null,
    };

    const config = buildImapConfig(account, a.emailAddress, a.password);
    const provider = deps.providerFactory(config);
    const health = await provider.healthCheck();
    if (!health.ok) throw new ImapError(health.details ?? 'IMAP connection failed');

    deps.secrets.set(handle, a.password);
    deps.db
      .prepare(
        `INSERT INTO accounts (id, provider, display_name, email_address, imap_host, imap_port,
           imap_use_tls, smtp_host, smtp_port, imap_password_keychain_handle, sync_state, is_enabled, created_at)
         VALUES (@id,@provider,@display_name,@email_address,@imap_host,@imap_port,@imap_use_tls,@smtp_host,@smtp_port,@imap_password_keychain_handle,@sync_state,@is_enabled,@created_at)`,
      )
      .run(account);
    deps.providers.set(provider);

    // Kick off the initial sync in the background; don't block the response.
    void deps.sync.initialSync(id);
    return { data: toView(account) };
  });

  app.get('/accounts', async () => {
    const rows = deps.db
      .prepare('SELECT * FROM accounts ORDER BY created_at ASC')
      .all() as AccountRow[];
    return { data: rows.map(toView) };
  });

  app.delete('/accounts/:id', async (req) => {
    const { id } = req.params as { id: string };
    const provider = deps.providers.get(id);
    if (provider) {
      await provider.stopWatching().catch(() => undefined);
      deps.providers.remove(id);
    }
    deps.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    deps.secrets.delete(`imap.${id}`);
    return { data: { deleted: true } };
  });

  app.post('/accounts/:id/resync', async (req) => {
    const { id } = req.params as { id: string };
    void deps.sync.initialSync(id);
    return { data: { resyncing: true } };
  });
}
```

> `deps.db.prepare(...).run(account)` uses better-sqlite3 named parameters; the `AccountRow` keys map to `@id`, `@provider`, etc. Extra row keys not in the SQL (e.g. `last_synced_at`, `oauth_keychain_handle`) must NOT be passed — better-sqlite3 throws on unused named params. So pass an explicit object of only the columns in the INSERT. Replace `.run(account)` with `.run({ id: account.id, provider: account.provider, display_name: account.display_name, email_address: account.email_address, imap_host: account.imap_host, imap_port: account.imap_port, imap_use_tls: account.imap_use_tls, smtp_host: account.smtp_host, smtp_port: account.smtp_port, imap_password_keychain_handle: account.imap_password_keychain_handle, sync_state: account.sync_state, is_enabled: account.is_enabled, created_at: account.created_at })`.

- [ ] **Step 5: Run test → PASS; full suite green; typecheck clean.**

- [ ] **Step 6: Commit**

```
git add apps/service/server/api/accounts.ts apps/service/server/server.ts apps/service/test/helpers/testServer.ts apps/service/test/accounts-routes.test.ts
git commit -m "feat(service): add accounts API (add IMAP/list/delete/resync) + provider wiring"
```

---

## Task 15: Threads API (list + detail)

**Files:**

- Create: `apps/service/server/api/threads.ts`
- Modify: `apps/service/server/server.ts` (register)
- Test: `apps/service/test/threads-routes.test.ts`

- [ ] **Step 1: Write the failing test** `apps/service/test/threads-routes.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { makeTestServer } from './helpers/testServer.js';

function seed(db: Parameters<typeof afterUse>[0]) {}
function afterUse(_db: unknown) {}

describe('threads routes', () => {
  it('lists threads and returns a thread with its messages', async () => {
    const { app, session, db } = await makeTestServer();
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','a@b.com')`,
    ).run();
    db.prepare(
      `INSERT INTO threads (id, account_id, subject_normalized, participants, message_count, last_message_at, state)
       VALUES ('th1','acc1','hello','["a@b.com"]',1,1000,'needs_classification')`,
    ).run();
    db.prepare(
      `INSERT INTO messages (id, account_id, provider_id, thread_id, from_address, direction, date_received, subject, snippet)
       VALUES ('m1','acc1','u1','th1','a@b.com','inbound',1000,'Hello','hi')`,
    ).run();

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/threads?accountId=acc1',
      headers: { authorization: `Bearer ${session}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toHaveLength(1);

    const detail = await app.inject({
      method: 'GET',
      url: '/api/v1/threads/th1',
      headers: { authorization: `Bearer ${session}` },
    });
    expect(detail.json().data.messages).toHaveLength(1);
    expect(detail.json().data.messages[0].subject).toBe('Hello');
    await app.close();
  });
});
```

- [ ] **Step 2: Run test, verify it FAILS** (404).

- [ ] **Step 3: Create `apps/service/server/api/threads.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3-multiple-ciphers';
import {
  NotFoundError,
  type EmailAddress,
  type MessageView,
  type ThreadSummary,
  type ThreadWithMessages,
} from '@secretary/shared-types';
import { ThreadsRepository } from '../db/repositories/ThreadsRepository.js';
import { MessagesRepository } from '../db/repositories/MessagesRepository.js';
import type { MessageRow, ThreadRow } from '../db/schema.js';

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

export function registerThreadsRoutes(app: FastifyInstance, deps: { db: Database.Database }): void {
  const threads = new ThreadsRepository(deps.db);
  const messages = new MessagesRepository(deps.db);

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
}
```

- [ ] **Step 4: Register in `server.ts`** — import `registerThreadsRoutes` and add `registerThreadsRoutes(api, deps);` in the `/api/v1` block.

- [ ] **Step 5: Run test → PASS; typecheck clean.**

- [ ] **Step 6: Commit**

```
git add apps/service/server/api/threads.ts apps/service/server/server.ts apps/service/test/threads-routes.test.ts
git commit -m "feat(service): add threads API (list + detail with messages)"
```

---

## Task 16: Send endpoint

**Files:**

- Modify: `apps/service/server/api/accounts.ts` (add send route)
- Test: `apps/service/test/send-route.test.ts`

- [ ] **Step 1: Write the failing test** `apps/service/test/send-route.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { makeTestServer } from './helpers/testServer.js';

const body = {
  displayName: 'Me',
  emailAddress: 'me@example.com',
  imapHost: 'imap.example.com',
  imapPort: 993,
  useTls: true,
  smtpHost: 'smtp.example.com',
  smtpPort: 465,
  password: 'secret',
};

describe('send route', () => {
  it('sends via the account provider', async () => {
    const { app, session } = await makeTestServer();
    const add = await app.inject({
      method: 'POST',
      url: '/api/v1/accounts/imap',
      headers: { authorization: `Bearer ${session}` },
      payload: body,
    });
    const id = add.json().data.id as string;

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/accounts/${id}/send`,
      headers: { authorization: `Bearer ${session}` },
      payload: { to: [{ address: 'c@d.com' }], subject: 'Hi', bodyText: 'hello' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.providerMessageId).toMatch(/^fake-/);
    await app.close();
  });
});
```

- [ ] **Step 2: Run test, verify it FAILS** (send route 404).

- [ ] **Step 3: Add the send route in `apps/service/server/api/accounts.ts`** (inside `registerAccountsRoutes`, add imports for `z` already present; add `NotFoundError` to the shared-types import):

```ts
const sendSchema = z.object({
  to: z.array(z.object({ address: z.string().email(), name: z.string().optional() })).min(1),
  cc: z.array(z.object({ address: z.string().email(), name: z.string().optional() })).optional(),
  subject: z.string().optional(),
  bodyText: z.string().min(1),
  bodyHtml: z.string().optional(),
  inReplyToMessageId: z.string().optional(),
});

app.post('/accounts/:id/send', async (req) => {
  const { id } = req.params as { id: string };
  const provider = deps.providers.get(id);
  if (!provider) throw new NotFoundError('Account not connected');
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid send payload');
  const sent = await provider.sendMessage(parsed.data);
  return { data: { providerMessageId: sent.providerMessageId } };
});
```

Add `NotFoundError` to the `@secretary/shared-types` import at the top of the file.

- [ ] **Step 4: Run test → PASS; full suite green.**

- [ ] **Step 5: Commit**

```
git add apps/service/server/api/accounts.ts apps/service/test/send-route.test.ts
git commit -m "feat(service): add minimal send endpoint (manual reply)"
```

---

## Task 17: Startup wiring (index.ts) — construct deps, resume sync

**Files:**

- Modify: `apps/service/server/index.ts`

- [ ] **Step 1: Update `apps/service/server/index.ts`** to construct the new deps, pass them to `buildServer`, and resume sync for enabled accounts. Add imports:

```ts
import { ProviderRegistry } from './providers/ProviderRegistry.js';
import { SyncManager } from './sync/SyncManager.js';
import { ImapProvider } from './providers/ImapProvider.js';
import { buildImapConfig } from './providers/imapConfig.js';
import type { ImapConfig } from './providers/ProviderInterface.js';
import type { AccountRow } from './db/schema.js';
```

After `const eventBus = new EventBus();` add:

```ts
const providers = new ProviderRegistry();
const sync = new SyncManager(db, providers, eventBus);
const providerFactory = (config: ImapConfig) => new ImapProvider(config);
```

Add `secrets: store, providers, sync, providerFactory,` to the `buildServer({ ... })` call.

After `await app.listen(...)`, resume enabled IMAP accounts:

```ts
const enabled = db
  .prepare("SELECT * FROM accounts WHERE is_enabled = 1 AND provider = 'imap'")
  .all() as AccountRow[];
for (const acc of enabled) {
  const pass = store.get(acc.imap_password_keychain_handle ?? '');
  if (!pass) continue;
  try {
    providers.set(providerFactory(buildImapConfig(acc, acc.email_address, pass)));
    void sync.initialSync(acc.id);
  } catch (err) {
    log.warn(
      { accountId: acc.id, err: err instanceof Error ? err.message : 'unknown' },
      'account resume failed',
    );
  }
}
```

- [ ] **Step 2: Typecheck** `pnpm --filter @secretary/service typecheck` → clean.

- [ ] **Step 3: Run the full suite** → green (index.ts is excluded from coverage but must compile).

- [ ] **Step 4: Commit**

```
git add apps/service/server/index.ts
git commit -m "feat(service): wire providers/sync into startup and resume enabled accounts"
```

---

## Task 18: Manual verification runbook

**Files:**

- Create: `docs/PHASE-3-MANUAL-VERIFICATION.md`

- [ ] **Step 1: Create `docs/PHASE-3-MANUAL-VERIFICATION.md`** documenting:
  - Prereqs: certs (Phase 2), a session token (bootstrap exchange), and either a Gmail app password or Proton Bridge running.
  - Gmail: enable IMAP + create an app password; `imapHost=imap.gmail.com port=993 useTls=true`, `smtpHost=smtp.gmail.com port=465`.
  - Proton Bridge: install Bridge (paid account), `imapHost=127.0.0.1 port=1143 useTls=false`, `smtpHost=127.0.0.1 port=1025`, Bridge-provided password.
  - The curl flow:
    ```powershell
    # get a session token first (tray "Open Secretary" prints the bootstrap fragment, or exchange via POST /auth/session)
    $T = '<session token>'
    curl.exe -k -X POST https://localhost:47824/api/v1/accounts/imap -H "authorization: Bearer $T" -H "content-type: application/json" -d '{ "displayName":"Test","emailAddress":"you@gmail.com","imapHost":"imap.gmail.com","imapPort":993,"useTls":true,"smtpHost":"smtp.gmail.com","smtpPort":465,"password":"<app password>" }'
    curl.exe -k https://localhost:47824/api/v1/threads -H "authorization: Bearer $T"          # after a few seconds, synced threads
    curl.exe -k https://localhost:47824/api/v1/threads/<id> -H "authorization: Bearer $T"      # thread + messages
    curl.exe -k -X POST https://localhost:47824/api/v1/accounts/<id>/send -H "authorization: Bearer $T" -H "content-type: application/json" -d '{ "to":[{"address":"someone@example.com"}],"subject":"Test","bodyText":"hello from Secretary" }'
    ```
  - Acceptance: account adds + syncs last 90 days; new mail appears within ~15s; a reply sends.

- [ ] **Step 2: Commit**

```
git add docs/PHASE-3-MANUAL-VERIFICATION.md
git commit -m "docs(phase-3): add Gmail/Proton manual verification runbook"
```

---

## Task 19: Full verification sweep

**Files:** none (verification only)

- [ ] **Step 1:** `pnpm -r typecheck` → clean (all packages).
- [ ] **Step 2:** `pnpm -r test` → green (gateway 39, crypto 19, llm-protocol 14, shared-types +1, service prior 46 + new Phase 3 tests).
- [ ] **Step 3:** `pnpm lint` → exit 0. `pnpm format:check` → clean. (Run `pnpm format` + re-stage if needed.)
- [ ] **Step 4:** Confirm BRIEF §14 Phase 3 acceptance against the manual runbook; note any divergence in the brief.
- [ ] **Step 5:** Commit any lint/format fixes:

```
git add -A && git commit -m "chore(service): phase 3 verification sweep"
```

---

## Self-Review (completed during planning)

**Spec coverage:** EmailProvider interface (T9), ImapProvider over imapflow/nodemailer/mailparser (T11), accounts add/list/delete/resync (T14), threads list/detail (T15), send (T16), initial 90-day sync + IDLE incremental + persist + threading + contacts + action-log (T13 via SyncManager + T11 watcher), domain types + RawMessage/SendInput (T1), repositories (T5–T8), ImapConfig + loopback/Proton TLS (T10), startup resume (T17), manual Gmail/Proton runbook (T18), `ImapError` (T1). Testing strategy (fakes + fixtures + manual) realized across tasks.

**Placeholder scan:** No TBD/TODO; every code step has complete code. The two reference-code caveats (the `ImapError` import guard in T11; the better-sqlite3 named-params note in T14) are explicit instructions, not placeholders.

**Type consistency:** `EmailProvider`/`SyncResult` (T9) used identically in `FakeEmailProvider` (T9), `ImapProvider` (T11), `ProviderRegistry` (T12), `SyncManager` (T13). `ImapConfig` shape (T9) matches `buildImapConfig` (T10) and `ImapProvider` ctor (T11). `RawMessage` fields (T1) match `MessagesRepository.insert` (T7), `normalize`/`threading` (T3/T4), and `ImapProvider.parse` (T11). `AccountView`/`ThreadSummary`/`MessageView`/`ThreadWithMessages` (T1) match the accounts/threads route mappers (T14/T15). `ServerDeps` additions (T14) are consumed by `index.ts` + the test helper (T14/T17). Repository method names (`recordSeen`, `threadIdForSubject`, `threadIdForMessageIds`, `touch`, `create`, `insert`, `listByThread`, `append`) are consistent between definitions and call sites in `SyncManager`/routes.
