# Secretary Phase 6a — Voice Editing Design

**Date:** 2026-06-02
**Status:** Approved design, ready for implementation plan
**Builds on:** Phase 5 drafting (`PromptAssembler.buildDraftPrompt`, the `style_guide` setting override, per-contact `style_notes`, `style_examples` retrieval), the designed PWA screens (Settings/Contacts placeholders), Phase 5.5.

## Overview

Phase 6 ("voice tuning tools") is decomposed into **6a (this spec)**, 6b (sent-mail mining + review + heavy-edit detection), and 6c (embedding retrieval, optional/deferred). **6a** delivers the user-facing voice controls, over existing APIs with small server touches:

1. **Style-guide editor** in Settings (BRIEF §14 Phase 6 item 1).
2. **Per-contact `style_notes` editor** (item 2) via a Contacts detail/edit screen.

Already done (no work): item 4 (style-examples retrieval at draft time — `PromptAssembler` already samples `style_examples` by category).

**Deferred out of 6a:** heavy-edit detection (item 5) → **6b**. The spec originally placed it here, but the current save-then-send flow makes `draft.body_text == final_body_sent` at send time (the PWA PATCHes the edit into `body_text` before sending), so a meaningful comparison needs the agent's _original_ generated body preserved — which belongs with 6b's sent-mail analysis (and avoids touching the verified send/offline flow or adding a schema change to this UI-only slice). Also deferred: 6b (mining), 6c (sqlite-vec embeddings).

**Acceptance (the 6a subset of BRIEF §14 Phase 6):** editing the style guide affects future drafts immediately; per-contact style notes appear in that contact's draft prompt.

## Scope

**In:** style-guide editor (Settings); contact detail/edit screen (category, notes, style_notes, do-not-auto-draft). **Deferred:** heavy-edit detection (→ 6b); 6b sent-mail mining + review; 6c embeddings; a syntax-highlighted markdown editor (plain textarea suffices); any UI surfacing of analytics.

## Architecture

### Server (`apps/service`)

**1. Effective style guide endpoint + shared resolver.** Extract the voice-guide resolution `PromptAssembler.voiceGuide()` performs into a shared helper `apps/service/server/agent/voiceGuide.ts`:

```
resolveVoiceGuide(settings: Pick<SettingsRepository,'get'>, promptsDir?: string): { styleGuide: string; isDefault: boolean }
```

where `styleGuide = settings.style_guide override (if a non-empty string) else the contents of prompts/voice-baseline.md` (the baseline read is cached module-level), and `isDefault = true` when there's no non-empty override. `promptsDir` defaults to the agent dir's `../prompts`. `PromptAssembler.voiceGuide()` delegates to it (returns `.styleGuide`), preserving current draft behavior. Then add `GET /api/v1/settings/style-guide` → `{ data: resolveVoiceGuide(repo) }` (i.e. `{ styleGuide, isDefault }`). Saving uses the existing `PATCH /settings { style_guide }`; **reset** = `PATCH /settings { style_guide: "" }` (the resolver treats an empty/whitespace override as "use baseline"). No new write route.

**2. `style_notes` as plain text + exposed on `ContactView`.** Today `ContactsRepository.patch` does `JSON.stringify(styleNotes)` (which double-quotes the value in the draft prompt) and `ContactView` omits it. 6a:

- `ContactView` (`packages/shared-types/src/domain.ts`) gains `styleNotes: string | null`; the `contactView` mapper in `contacts.ts` reads `row.style_notes`.
- The contacts `patch` route schema tightens `styleNotes` from `z.unknown()` to `z.string()`; `ContactPatch.styleNotes` becomes `string`.
- `ContactsRepository.patch` stores `style_notes` as the **raw string** (drops `JSON.stringify`).
- `PromptAssembler.buildDraftPrompt` already injects `contact.style_notes` — now it reads a clean string. (The `style_notes` column has no production data — no editor ever wrote it — so the storage-semantics change needs no migration/backfill.)

No other server changes; no schema migration; the drafts/send/offline flow is untouched.

### PWA (`apps/service/pwa`)

**Hooks** (`src/api/hooks.ts`, extend): `useStyleGuide()` (GET `/settings/style-guide`, key `['style-guide']`); `useSaveStyleGuide()` (PATCH `/settings { style_guide }`, invalidates `['style-guide']` + `['settings']`); `useContact(id)` (GET `/contacts/:id`, key `['contact', id]`); `usePatchContact()` (PATCH `/contacts/:id`, invalidates `['contact', id]` + `['contacts']`).

**Screens:**

- **Settings** (`src/routes/Settings.tsx`): add a **"Voice / style guide"** section — a `<textarea>` pre-filled from `useStyleGuide()` (shows "(using default)" when `isDefault`), **Save** + **Reset to default** buttons. Keep the existing Notifications + settings-dump sections.
- **Contacts** (`src/routes/Contacts.tsx`): list rows become tappable → route to **`/contacts/:id`** (wrap each row in a wouter `<Link>`).
- **ContactDetail** (`src/routes/ContactDetail.tsx`, new; route `/contacts/:id` added in `App.tsx`): a small edit form — **category** (`<select>` over the 7 categories), **notes** (textarea), **style notes** (textarea), **do-not-auto-draft** (checkbox) — pre-filled from `useContact(id)`; **Save** via `usePatchContact`; read-only stats (in/out counts, last contact). Loading/error/not-found states per the existing pattern.

### Data flow

Style guide: editor → `PATCH /settings { style_guide }` → `resolveVoiceGuide`/`PromptAssembler.voiceGuide()` reads the override on the next draft (immediate effect; no restart). Per-contact: edit screen → `PATCH /contacts/:id { styleNotes, … }` → `buildDraftPrompt` injects `style_notes` for that contact's next draft.

### Error / edge cases

- No style-guide override → editor shows the baseline + "(using default)"; Save with empty content = Reset (falls back to baseline).
- Contact not found → 404 (existing); ContactDetail shows "Not found." Invalid category → validation error (existing `z.enum`).
- `style_notes` round-trips as a plain string (no JSON quoting) end to end.

### Testing (per BRIEF §18: logic TDD; UI manual)

- **Server (TDD via `app.inject` + unit)**: `resolveVoiceGuide` (no override → baseline + `isDefault:true`; non-empty override → it + `isDefault:false`; whitespace override → baseline) and `GET /settings/style-guide`; contacts `styleNotes` round-trip (PATCH a plain string → `ContactView.styleNotes` returns it verbatim, not JSON-quoted) and that `buildDraftPrompt` includes the clean string; `PromptAssembler.voiceGuide()` still returns the override/baseline correctly after delegating to `resolveVoiceGuide` (existing draft tests stay green).
- **PWA**: `useStyleGuide`/`usePatchContact`/`useContact` typecheck against the DTOs; the Settings editor + ContactDetail screen are manually verified (runbook). One light render test for ContactDetail's field pre-fill is optional, not required.

## Out of scope (explicit)

- **Heavy-edit detection (item 5) → 6b** — needs the agent's original generated body preserved (the save-then-send flow overwrites `body_text`); folded into 6b's sent-mail analysis.
- 6b: sent-mail mining job + review UI (its own spec/plan).
- 6c: sqlite-vec embedding retrieval.
- Syntax-highlighted markdown editing; rich text; versioning/history of the style guide.
- Bulk contact editing; contact search/filter UI changes (the list stays as-is, just tappable).
