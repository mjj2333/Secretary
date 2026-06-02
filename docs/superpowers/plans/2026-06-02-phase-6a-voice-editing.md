# Phase 6a — Voice Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user edit the agent's voice — a style-guide editor in Settings and a per-contact editor (incl. `style_notes`) — over the existing settings/contacts APIs, with two small server additions.

**Architecture:** Server extracts the voice-guide resolution into a shared `resolveVoiceGuide` (used by `PromptAssembler` + a new `GET /settings/style-guide`), and exposes/normalizes `style_notes` as plain text on `ContactView`. The PWA adds a style-guide section to Settings and a `/contacts/:id` ContactDetail edit screen. No schema migration; the drafts/send flow is untouched.

**Tech Stack:** Fastify 5 + better-sqlite3 (service); Vite + React + wouter + TanStack Query (PWA); Vitest.

**Spec:** `docs/superpowers/specs/2026-06-02-phase-6a-voice-editing-design.md`

---

## Conventions

- **Service** (`@secretary/service`, strict NodeNext, `.js` imports): test `pnpm --filter @secretary/service test [substr]`; typecheck `…typecheck`. Harness `makeTestServer()` → `{ app, session, db }`; seed via `db.prepare(INSERT…).run()`; assert via `app.inject` + `res.json().data`.
- **PWA** (`@secretary/pwa`, bundler res, DOM): test/typecheck/build via `pnpm --filter @secretary/pwa …`.
- **`@secretary/shared-types` is a built package** — after editing `domain.ts`, run `pnpm --filter @secretary/shared-types build` so the service + PWA see the new field.
- **TDD the server logic** (the resolver, the routes, the styleNotes round-trip) via `app.inject`/unit. **UI is manually verified** (BRIEF §18) — the PWA screens are scaffold → typecheck/build → runbook.
- Commits: conventional + trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` via Bash heredoc. Windows; service tests need the Node ABI (do NOT run `pnpm dev`).
- Branch: `feat/phase-6a-voice-editing` (created, spec committed).
- **No schema migration, no change to the drafts/send/offline flow.** Heavy-edit detection is deferred to 6b.

## File Structure

**Service — create:** `server/agent/voiceGuide.ts`; test `test/voice-guide.test.ts`.
**Service — modify:** `server/agent/PromptAssembler.ts` (delegate `voiceGuide()`); `server/api/settings.ts` (+ `GET /settings/style-guide`); `server/api/contacts.ts` (`styleNotes` on view + `z.string()` patch); `server/db/repositories/ContactsRepository.ts` (store raw string; `ContactPatch.styleNotes: string`); `packages/shared-types/src/domain.ts` (`ContactView.styleNotes`); tests `test/settings-routes.test.ts`, `test/contacts-routes.test.ts`.
**PWA — create:** `src/routes/ContactDetail.tsx`.
**PWA — modify:** `src/api/hooks.ts` (+4 hooks); `src/routes/Settings.tsx` (style-guide section); `src/routes/Contacts.tsx` (tappable rows); `src/App.tsx` (`/contacts/:id` route).
**Docs:** `BRIEF.md`; `docs/PHASE-6a-MANUAL-VERIFICATION.md`.

---

### Task 1: Server — shared `resolveVoiceGuide` + `GET /settings/style-guide`

**Files:** Create `apps/service/server/agent/voiceGuide.ts`, `apps/service/test/voice-guide.test.ts`; modify `apps/service/server/agent/PromptAssembler.ts`, `apps/service/server/api/settings.ts`, `apps/service/test/settings-routes.test.ts`.

- [ ] **Step 1: Write the failing unit test** — `apps/service/test/voice-guide.test.ts`:

```typescript
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveVoiceGuide } from '../server/agent/voiceGuide.js';

function promptsDirWith(baseline: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'secretary-prompts-'));
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'voice-baseline.md'), baseline);
  return join(dir, 'prompts');
}
const fakeSettings = (val: unknown) => ({ get: <T>(_k: string): T | undefined => val as T });

describe('resolveVoiceGuide', () => {
  it('returns the baseline + isDefault when there is no override', () => {
    const out = resolveVoiceGuide(fakeSettings(undefined), promptsDirWith('BASELINE VOICE'));
    expect(out).toEqual({ styleGuide: 'BASELINE VOICE', isDefault: true });
  });
  it('returns a non-empty override + not-default', () => {
    const out = resolveVoiceGuide(fakeSettings('MY VOICE'), promptsDirWith('BASELINE VOICE'));
    expect(out).toEqual({ styleGuide: 'MY VOICE', isDefault: false });
  });
  it('treats a whitespace-only override as default (baseline)', () => {
    const out = resolveVoiceGuide(fakeSettings('   '), promptsDirWith('BASELINE VOICE'));
    expect(out.isDefault).toBe(true);
    expect(out.styleGuide).toBe('BASELINE VOICE');
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @secretary/service test voice-guide` → FAIL (module missing).

- [ ] **Step 3: Implement `apps/service/server/agent/voiceGuide.ts`:**

```typescript
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SettingsRepository } from '../db/repositories/SettingsRepository.js';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROMPTS_DIR = join(here, '..', 'prompts');
const baselineCache = new Map<string, string>();

function baseline(promptsDir: string): string {
  let cached = baselineCache.get(promptsDir);
  if (cached === undefined) {
    cached = readFileSync(join(promptsDir, 'voice-baseline.md'), 'utf8');
    baselineCache.set(promptsDir, cached);
  }
  return cached;
}

/** The effective voice guide: a non-empty `style_guide` setting override, else the baseline markdown. */
export function resolveVoiceGuide(
  settings: Pick<SettingsRepository, 'get'>,
  promptsDir: string = DEFAULT_PROMPTS_DIR,
): { styleGuide: string; isDefault: boolean } {
  const override = settings.get<string>('style_guide');
  if (typeof override === 'string' && override.trim().length > 0) {
    return { styleGuide: override, isDefault: false };
  }
  return { styleGuide: baseline(promptsDir), isDefault: true };
}
```

(Confirm `SettingsRepository.get` is generic `get<T>(key): T | undefined` — the existing `voiceGuide()` calls `this.settings.get<string>('style_guide')`, so it is.)

- [ ] **Step 4: Run to verify pass** — `pnpm --filter @secretary/service test voice-guide` → PASS (3 tests).

- [ ] **Step 5: Delegate `PromptAssembler.voiceGuide()`** — in `apps/service/server/agent/PromptAssembler.ts`: add `import { resolveVoiceGuide } from './voiceGuide.js';`, remove the `private voiceBaseline: string | null = null;` field, and replace the `voiceGuide()` method body with:

```typescript
  private voiceGuide(): string {
    return resolveVoiceGuide(this.settings, this.promptsDir).styleGuide;
  }
```

(Leaves `buildDraftPrompt`'s `this.voiceGuide()` call unchanged. Remove the now-unused `readFileSync`/baseline plumbing only if it's not used elsewhere in the file — `classifierSystemPrompt`/`drafterSystemPrompt` still use `readFileSync`, so keep the import.)

- [ ] **Step 6: Add the route** — in `apps/service/server/api/settings.ts`, add `import { resolveVoiceGuide } from '../agent/voiceGuide.js';` and a route (before or after the existing ones):

```typescript
app.get('/settings/style-guide', async () => ({ data: resolveVoiceGuide(repo) }));
```

(`repo` is the `SettingsRepository` already constructed in `registerSettingsRoutes`. `resolveVoiceGuide(repo)` uses the default prompts dir = `server/prompts`.)

- [ ] **Step 7: Write the failing route test** — append to `apps/service/test/settings-routes.test.ts`:

```typescript
it('GET /settings/style-guide returns the baseline + isDefault when unset', async () => {
  const { app, session } = await makeTestServer();
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/settings/style-guide',
    headers: { authorization: `Bearer ${session}` },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().data.isDefault).toBe(true);
  expect(res.json().data.styleGuide.length).toBeGreaterThan(0);
  await app.close();
});

it('GET /settings/style-guide returns the override when style_guide is set', async () => {
  const { app, session } = await makeTestServer();
  await app.inject({
    method: 'PATCH',
    url: '/api/v1/settings',
    headers: { authorization: `Bearer ${session}` },
    payload: { style_guide: 'Write tersely.' },
  });
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/settings/style-guide',
    headers: { authorization: `Bearer ${session}` },
  });
  expect(res.json().data).toEqual({ styleGuide: 'Write tersely.', isDefault: false });
  await app.close();
});
```

(Read the existing `settings-routes.test.ts` first for the `makeTestServer` import + style.)

- [ ] **Step 8: Run + typecheck** — `pnpm --filter @secretary/service test settings-routes` → PASS; `pnpm --filter @secretary/service test` → all green (incl. the existing PromptAssembler/draft tests after the delegation); `pnpm --filter @secretary/service typecheck` → exit 0.

- [ ] **Step 9: Commit**

```bash
git add apps/service/server/agent/voiceGuide.ts apps/service/server/agent/PromptAssembler.ts apps/service/server/api/settings.ts apps/service/test/voice-guide.test.ts apps/service/test/settings-routes.test.ts
git commit -F - <<'MSG'
feat(service): resolveVoiceGuide helper + GET /settings/style-guide

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 2: Server — `style_notes` as plain text on `ContactView`

**Files:** Modify `packages/shared-types/src/domain.ts`, `apps/service/server/api/contacts.ts`, `apps/service/server/db/repositories/ContactsRepository.ts`, `apps/service/test/contacts-routes.test.ts`.

- [ ] **Step 1: Add the DTO field** — in `packages/shared-types/src/domain.ts`, add `styleNotes: string | null;` to `ContactView` (next to `notes`). Then `pnpm --filter @secretary/shared-types build` (exit 0).

- [ ] **Step 2: Write the failing test** — append to `apps/service/test/contacts-routes.test.ts`:

```typescript
it('PATCH styleNotes stores + returns a plain string (not JSON-quoted)', async () => {
  const { app, session, db } = await makeTestServer();
  db.prepare(
    `INSERT INTO contacts (id, email_address, display_name, category, total_messages_in, total_messages_out, do_not_auto_draft) VALUES ('c1','jane@x.com','Jane','client_established',1,0,0)`,
  ).run();
  const patch = await app.inject({
    method: 'PATCH',
    url: '/api/v1/contacts/c1',
    headers: { authorization: `Bearer ${session}` },
    payload: { styleNotes: 'Keep it warm and brief.' },
  });
  expect(patch.statusCode).toBe(200);
  expect(patch.json().data.styleNotes).toBe('Keep it warm and brief.');
  const get = await app.inject({
    method: 'GET',
    url: '/api/v1/contacts/c1',
    headers: { authorization: `Bearer ${session}` },
  });
  expect(get.json().data.styleNotes).toBe('Keep it warm and brief.');
  await app.close();
});
```

(Read `contacts-routes.test.ts` first for the seed/import pattern; align the `category` to a valid enum value like `client_established`.)

- [ ] **Step 3: Run to verify failure** — `pnpm --filter @secretary/service test contacts-routes` → FAIL (`styleNotes` undefined on the view; and/or it comes back JSON-quoted).

- [ ] **Step 4: Implement** —
  - `apps/service/server/db/repositories/ContactsRepository.ts`: change `ContactPatch.styleNotes?: unknown` → `styleNotes?: string`; and in `patch`, change the styleNotes branch to store the raw string:
    ```typescript
    if (fields.styleNotes !== undefined) {
      sets.push('style_notes = ?');
      vals.push(fields.styleNotes);
    }
    ```
  - `apps/service/server/api/contacts.ts`: in `patchSchema`, change `styleNotes: z.unknown().optional()` → `styleNotes: z.string().optional()`; in `contactView`, add `styleNotes: row.style_notes,` (the `ContactRow.style_notes` column is `string | null`). The PATCH handler's `if (parsed.data.styleNotes !== undefined) patch.styleNotes = parsed.data.styleNotes;` now assigns a `string` — typechecks against the new `ContactPatch`.

- [ ] **Step 5: Run + typecheck** — `pnpm --filter @secretary/service test contacts-routes` → PASS; `pnpm --filter @secretary/service test` → all green; `pnpm --filter @secretary/service typecheck` → exit 0; `pnpm --filter @secretary/pwa typecheck` → exit 0 (consumes the rebuilt `ContactView`).

- [ ] **Step 6: Commit**

```bash
git add packages/shared-types/src/domain.ts apps/service/server/api/contacts.ts apps/service/server/db/repositories/ContactsRepository.ts apps/service/test/contacts-routes.test.ts
git commit -F - <<'MSG'
feat(service): expose contact styleNotes as plain text on ContactView

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 3: PWA — voice/contact hooks

**Files:** Modify `apps/service/pwa/src/api/hooks.ts`.

- [ ] **Step 1: Add the hooks** — append to `apps/service/pwa/src/api/hooks.ts` (ensure `ContactView` is imported from `@secretary/shared-types`):

```typescript
export function useStyleGuide(): UseQueryResult<{ styleGuide: string; isDefault: boolean }> {
  return useQuery({
    queryKey: ['style-guide'],
    queryFn: () => apiFetch<{ styleGuide: string; isDefault: boolean }>('/settings/style-guide'),
  });
}

export function useSaveStyleGuide() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { styleGuide: string }) =>
      apiFetch<Record<string, unknown>>('/settings', {
        method: 'PATCH',
        body: JSON.stringify({ style_guide: vars.styleGuide }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['style-guide'] });
      void qc.invalidateQueries({ queryKey: ['settings'] });
    },
  });
}

export function useContact(id: string): UseQueryResult<ContactView> {
  return useQuery({
    queryKey: ['contact', id],
    queryFn: () => apiFetch<ContactView>(`/contacts/${id}`),
    enabled: id.length > 0,
  });
}

export function usePatchContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      id: string;
      category?: string;
      notes?: string;
      styleNotes?: string;
      doNotAutoDraft?: boolean;
    }) => {
      const { id, ...fields } = vars;
      return apiFetch<ContactView>(`/contacts/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(fields),
      });
    },
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ['contact', vars.id] });
      void qc.invalidateQueries({ queryKey: ['contacts'] });
    },
  });
}
```

- [ ] **Step 2: Typecheck + commit** — `pnpm --filter @secretary/pwa typecheck` → exit 0.

```bash
git add apps/service/pwa/src/api/hooks.ts
git commit -F - <<'MSG'
feat(pwa): style-guide + contact query/mutation hooks

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 4: PWA — style-guide editor in Settings

**Files:** Modify `apps/service/pwa/src/routes/Settings.tsx`.

- [ ] **Step 1: Add a Voice section** — READ the current `Settings.tsx` first (it has a Notifications section + the settings dump from Phase 5.5). Add a **"Voice / style guide"** `<section>` (above the settings dump). The editor seeds a local `<textarea>` from `useStyleGuide()` and saves via `useSaveStyleGuide()`; **Reset** saves an empty string:

```typescript
import { useEffect, useState } from 'react';
import { useStyleGuide, useSaveStyleGuide } from '../api/hooks.js';
// …existing imports (useSettings, enablePush, etc.) stay…

function StyleGuideEditor(): JSX.Element {
  const q = useStyleGuide();
  const save = useSaveStyleGuide();
  const [text, setText] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (q.data) setText(q.data.styleGuide);
  }, [q.data?.styleGuide]);

  if (q.isLoading) return <p>Loading…</p>;
  if (q.error) return <p className="text-red-600">{(q.error as Error).message}</p>;

  const onSave = (value: string): void => {
    setMsg(null);
    save.mutate(
      { styleGuide: value },
      {
        onSuccess: () => setMsg(value.trim() ? 'Saved.' : 'Reset to default.'),
        onError: (e: unknown) => setMsg(e instanceof Error ? e.message : 'Save failed'),
      },
    );
  };

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-slate-900">
        Voice / style guide{q.data?.isDefault ? ' (using default)' : ''}
      </h2>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="min-h-[200px] w-full rounded-lg border border-slate-300 p-2.5 text-[13px] leading-relaxed"
      />
      <div className="mt-2 flex gap-2">
        <button type="button" disabled={save.isPending} onClick={() => onSave(text)} className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">Save</button>
        <button type="button" disabled={save.isPending} onClick={() => { setText(''); onSave(''); }} className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 disabled:opacity-50">Reset to default</button>
      </div>
      {msg ? <p className="mt-1 text-xs text-slate-600">{msg}</p> : null}
    </section>
  );
}
```

Then render `<StyleGuideEditor />` inside the Settings layout (e.g. as the first `<section>` in the existing `<div className="flex flex-col gap-4">`). Keep the Notifications + settings-dump sections.

NOTE: after a Reset (save `''`), `useStyleGuide` is invalidated → refetches → `isDefault:true` + the baseline; the `useEffect` re-seeds the textarea with the baseline. Good.

- [ ] **Step 2: Typecheck + commit** — `pnpm --filter @secretary/pwa typecheck` → exit 0; `pnpm --filter @secretary/pwa test` → existing pass.

```bash
git add apps/service/pwa/src/routes/Settings.tsx
git commit -F - <<'MSG'
feat(pwa): style-guide editor in Settings

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 5: PWA — ContactDetail edit screen + tappable Contacts

**Files:** Create `apps/service/pwa/src/routes/ContactDetail.tsx`; modify `apps/service/pwa/src/routes/Contacts.tsx`, `apps/service/pwa/src/App.tsx`.

- [ ] **Step 1: Create `apps/service/pwa/src/routes/ContactDetail.tsx`:**

```typescript
import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { useContact, usePatchContact } from '../api/hooks.js';

const CATEGORIES = ['client_established', 'client_new', 'screening', 'personal', 'vendor', 'noise', 'unknown'] as const;

export function ContactDetail({ id }: { id: string }): JSX.Element {
  const q = useContact(id);
  const patch = usePatchContact();
  const [, setLocation] = useLocation();
  const [category, setCategory] = useState('unknown');
  const [notes, setNotes] = useState('');
  const [styleNotes, setStyleNotes] = useState('');
  const [doNotAutoDraft, setDoNotAutoDraft] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    const c = q.data;
    if (c) {
      setCategory(c.category);
      setNotes(c.notes ?? '');
      setStyleNotes(c.styleNotes ?? '');
      setDoNotAutoDraft(c.doNotAutoDraft);
    }
  }, [q.data?.id]);

  if (q.isLoading) return <p>Loading…</p>;
  if (q.error) return <p className="text-red-600">{(q.error as Error).message}</p>;
  const c = q.data;
  if (!c) return <p>Not found.</p>;

  const onSave = (): void => {
    setMsg(null);
    patch.mutate(
      { id, category, notes, styleNotes, doNotAutoDraft },
      {
        onSuccess: () => setMsg('Saved.'),
        onError: (e: unknown) => setMsg(e instanceof Error ? e.message : 'Save failed'),
      },
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <button type="button" onClick={() => setLocation('/contacts')} className="self-start text-sm text-slate-500">‹ Contacts</button>
      <h2 className="font-semibold">{c.displayName ?? c.emailAddress}</h2>
      <p className="text-xs text-slate-500">{c.emailAddress} · in {c.totalMessagesIn} / out {c.totalMessagesOut}</p>

      <label className="text-xs font-semibold text-slate-700">Category
        <select value={category} onChange={(e) => setCategory(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 p-2 text-sm">
          {CATEGORIES.map((cat) => <option key={cat} value={cat}>{cat}</option>)}
        </select>
      </label>

      <label className="text-xs font-semibold text-slate-700">Notes
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} className="mt-1 block min-h-[70px] w-full rounded-lg border border-slate-300 p-2 text-sm" />
      </label>

      <label className="text-xs font-semibold text-slate-700">Style notes (how the agent should write to them)
        <textarea value={styleNotes} onChange={(e) => setStyleNotes(e.target.value)} className="mt-1 block min-h-[70px] w-full rounded-lg border border-slate-300 p-2 text-sm" />
      </label>

      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input type="checkbox" checked={doNotAutoDraft} onChange={(e) => setDoNotAutoDraft(e.target.checked)} />
        Don't auto-draft for this contact
      </label>

      <button type="button" disabled={patch.isPending} onClick={onSave} className="self-start rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
        {patch.isPending ? 'Saving…' : 'Save'}
      </button>
      {msg ? <p className="text-xs text-slate-600">{msg}</p> : null}
    </div>
  );
}
```

- [ ] **Step 2: Make Contacts rows tappable** — in `apps/service/pwa/src/routes/Contacts.tsx`, wrap each list row in a wouter `<Link href={`/contacts/${c.id}`}>`. READ the current file; change the `<li>` body to:

```typescript
import { Link } from 'wouter';
// …
      {(q.data ?? []).map((c) => (
        <li key={c.id} className="py-2 text-sm">
          <Link href={`/contacts/${c.id}`} className="block">
            {c.displayName ?? c.emailAddress} · {c.category}
          </Link>
        </li>
      ))}
```

- [ ] **Step 3: Add the route** — in `apps/service/pwa/src/App.tsx`, import `ContactDetail` and add a route **before** the catch-all (and after the `/contacts` route):

```typescript
import { ContactDetail } from './routes/ContactDetail.js';
// …
        <Route path="/contacts/:id">{(p) => <ContactDetail id={p.id ?? ''} />}</Route>
```

(Place it after `<Route path="/contacts" component={Contacts} />`. wouter's `<Switch>` matches the first; `/contacts` is exact so `/contacts/:id` won't be shadowed.)

- [ ] **Step 4: Typecheck + test + build** — `pnpm --filter @secretary/pwa typecheck` → exit 0; `pnpm --filter @secretary/pwa test` → existing pass; `pnpm --filter @secretary/pwa build` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/service/pwa/src/routes/ContactDetail.tsx apps/service/pwa/src/routes/Contacts.tsx apps/service/pwa/src/App.tsx
git commit -F - <<'MSG'
feat(pwa): ContactDetail edit screen + tappable contacts

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 6: BRIEF.md — Phase 6 note

**Files:** Modify `BRIEF.md`.

- [ ] **Step 1: Append to the §14 Phase 6 subsection** (after its Acceptance block):

```markdown
**Implementation note (2026-06-02):** Phase 6 is being delivered in slices. **6a (done):** the style-guide editor in Settings (`GET /settings/style-guide` + the existing `PATCH /settings`) and a per-contact editor (`/contacts/:id` ContactDetail — category, notes, style_notes, do-not-auto-draft); `style_notes` is now plain text on `ContactView` (was JSON-quoted). Item 4 (style-examples retrieval) was already implemented in Phase 5. **Deferred:** item 5 ("heavily edited" detection) → **6b**, because the save-then-send flow makes `body_text == final_body_sent` at send time, so it needs the agent's original generated body preserved (folded into 6b's sent-mail analysis). **6b (next):** sent-mail mining + review UI + heavy-edit detection. **6c (optional):** sqlite-vec embedding retrieval.
```

- [ ] **Step 2: Commit**

```bash
git add BRIEF.md
git commit -F - <<'MSG'
docs(brief): record Phase 6a + the 6b/6c split

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 7: Manual verification runbook

**Files:** Create `docs/PHASE-6a-MANUAL-VERIFICATION.md`.

- [ ] **Step 1: Write the runbook:**

````markdown
# Phase 6a — Manual Verification (Voice Editing)

Server logic is unit-tested (resolveVoiceGuide, the style-guide route, the styleNotes round-trip). The two
editor screens are verified here. PowerShell from `C:\Users\drice\Secretary`. Prereqs: the service running;
operator gateway + Ollama up if you want to confirm the voice change actually affects a generated draft.

## Setup (dev loop)

```powershell
pnpm --filter @secretary/service dev:server
pnpm --filter @secretary/pwa dev
```

Open http://localhost:5173, connect with the bootstrap token.

## Style guide editor

1. **Settings tab → "Voice / style guide"** — shows the current guide; with no override it reads
   "(using default)" and is pre-filled with the baseline.
2. Edit the text (e.g. add "Always sign off as 'Best, David'.") → **Save** → "Saved."
3. (With the gateway up) generate a draft on a thread → the change is reflected (it's read fresh per draft —
   `PromptAssembler.voiceGuide()` → `resolveVoiceGuide`).
4. **Reset to default** → the textarea repopulates with the baseline and the header shows "(using default)".

## Per-contact editor

5. **Contacts tab** → tap a contact → **ContactDetail** opens at `/contacts/:id`, pre-filled with category /
   notes / style notes / do-not-auto-draft + the in/out stats.
6. Set **Style notes** (e.g. "Very casual; first-name basis.") + change category → **Save** → "Saved."
7. (Gateway up) generate a draft for that contact's thread → the style notes appear in the prompt and shape
   the reply. Re-open the contact → the saved values persist (and `styleNotes` is plain text, not quoted).

## Acceptance

- Editing the style guide affects future drafts immediately. ✅ (steps 2–3)
- Per-contact style notes appear in that contact's draft prompt. ✅ (steps 6–7)
````

- [ ] **Step 2: Commit**

```bash
git add docs/PHASE-6a-MANUAL-VERIFICATION.md
git commit -F - <<'MSG'
docs: Phase 6a manual verification runbook

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 8: Full-green sweep

**Files:** none (verification + fixups).

- [ ] **Step 1: Tests + typecheck** — `pnpm -r test` → all green (service: + voice-guide, settings-routes, contacts-routes additions; pwa unchanged count). `pnpm -r typecheck` → exit 0.
- [ ] **Step 2: Lint + builds** — `pnpm lint` → exit 0 (PWA src scoped out of central ESLint; the new service code lints clean — fix real issues properly). `pnpm --filter @secretary/pwa build` and `pnpm --filter @secretary/service build` → exit 0.
- [ ] **Step 3: Format** — `pnpm format`; `pnpm format:check` → exit 0. If anything reformats, re-run `pnpm -r test`.
- [ ] **Step 4: Commit fixups (skip if none)**

```bash
git add -A
git commit -F - <<'MSG'
chore: lint/format fixups for Phase 6a

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

## Notes for the implementer

- **Rebuild `@secretary/shared-types` after Task 2's `domain.ts` edit** so the service + PWA typecheck against the new `ContactView.styleNotes`.
- **No schema migration** and **no change to the drafts/send/offline flow** — heavy-edit detection is 6b.
- The `style_notes` column has no production data (no editor ever wrote it), so switching its storage from JSON-stringified to a raw string needs no backfill.
- UI (Settings editor, ContactDetail) is manually verified (BRIEF §18) — no brittle network-dependent render tests; the hooks typecheck against the DTOs and the screens are exercised by the runbook.
- Do NOT run `pnpm dev` (Electron ABI). The voice-change-affects-draft check needs the operator gateway + Ollama (see the memory note on starting the gateway from the keychain).
