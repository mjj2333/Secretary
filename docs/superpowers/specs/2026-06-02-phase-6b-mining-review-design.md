# Secretary Phase 6b — Sent-Mail Mining + Review + Heavy-Edit Detection

**Date:** 2026-06-02
**Status:** Approved design, ready for implementation plan
**Branch:** `feat/phase-6b-mining-review`
**Builds on:** Phase 5 drafting (`PromptAssembler.buildDraftPrompt`, `StyleExamplesRepository.sample`, the `style_examples` few-shot, `Drafter`, the drafts send flow), Phase 6a (voice editing — `voiceGuide.ts`, the Settings "Voice / style guide" section, the per-contact editor), the `SequentialQueue` lanes (`classificationQueue`/`draftQueue`), `GatewayClient`, `eventBus` SSE, `ActionLogRepository`.

## Overview

Phase 6b completes BRIEF §14 Phase 6 with three pieces, delivered in one spec/plan/branch:

1. **Heavy-edit detection** (item 5, deferred from 6a) — built first; small and independent.
2. **Sent-mail mining job** (item 3) — a one-time job that processes the last ~200 outbound messages through the operator LLM into `pending` style examples (Approach A: a dedicated `SentMailMiner` + `SequentialQueue` lane).
3. **Review/approve UI** (item 3) — a PWA screen to approve / reject / edit mined examples. Only **approved** examples feed drafts.

**Design decisions (locked during brainstorming):**

- **Pending-until-approved.** Mined examples start `status='pending'`; `sample()` returns only `approved` rows, so nothing shapes the voice until the user approves it. The review UI is the approval gate.
- **Reply + inbound context.** The miner feeds the LLM both the sent reply and the inbound message it was responding to (truncated), so `context_summary` reflects the real situation.
- **One combined 6b** — heavy-edit lands first as an independent task, then mining + review.

**Acceptance (BRIEF §14 Phase 6, the 6b subset):**

- Sending a materially-rewritten draft logs `draft_heavily_edited` (ids + ratio only).
- Running the mining job populates `style_examples` with reasonable `pending` entries.
- Approving a mined example makes it eligible for the few-shot draft prompt immediately; rejecting/editing behaves accordingly.

## Scope

**In:** migration `0002` (style-example `status`, draft `generated_body_text`); `divergenceRatio` + heavy-edit logging on send; `MessagesRepository.recentOutbound`; `StyleExamplesRepository` mining/review methods + the `sample()` approved filter; `SentMailMiner` + `buildMiningPrompt`; the mining queue lane + `miningJob` tracker; `POST /style/mine`, `GET /style/mining-status`, `GET /style/examples`, `PATCH /style/examples/:id`; the `mining:progress` SSE event; `StyleExampleView`/`StyleExampleStatus` shared types; the `/voice/examples` PWA screen + hooks + the Settings entry point.

**Out (explicit):** 6c sqlite-vec embedding retrieval; multi-message mega-prompt mining; account-scoped mining (single account for v1); bulk approve/reject; deleting style examples (reject is sticky instead); changing the existing draft/offline send UX beyond the heavy-edit log; surfacing heavy-edit analytics in the UI (the log entry is for later analysis only, per BRIEF item 5).

## Architecture

### Data model — one migration `0002_phase_6b.sql`

```sql
ALTER TABLE style_examples ADD COLUMN status TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE drafts ADD COLUMN generated_body_text TEXT;
```

- **`style_examples.status`** ∈ `'pending' | 'approved' | 'rejected'`. Mining inserts rows as `'pending'`. `sample()` adds `AND status = 'approved'` so unreviewed/rejected examples never reach a draft. The `DEFAULT 'approved'` is harmless: the table is empty in production and mining always sets `status` explicitly; the default only keeps a hypothetical future hand-imported row usable. Rejection is **sticky** — rejected rows remain in the DB so a re-run skips them.
- **`drafts.generated_body_text`** (nullable) — the agent's **original** generated body, set once by `Drafter` at insert, never touched by the edit `PATCH` (which writes only `body_text`). This is the baseline the heavy-edit check compares against. Pre-migration draft rows are `NULL` → the check skips them.

Migration registration follows the existing incremental pattern (`migrations/index.ts`; `migrate.ts` runs versions `> applied`). `StyleExampleRow` gains `status: 'pending' | 'approved' | 'rejected'`; `DraftRow` gains `generated_body_text: string | null` (`db/schema.ts`).

### Heavy-edit detection (built first)

- **`divergenceRatio(generated: string, finalSent: string): number`** — new pure helper in `agent/draftDiff.ts`, beside `lineDiff`. Word-level LCS: tokenize on whitespace, `ratio = 1 − (2·lcs) / (genWords.length + sentWords.length)`, clamped to `[0,1]` (0 = identical, 1 = unrelated; both-empty → 0). Word-level (not the line-level `lineDiff`) because emails are often a few long lines, where line diffs are too coarse. Inputs are truncated to a word cap (`MAX_DIVERGENCE_WORDS = 2000`) to bound the O(n·m) cost.
- **`Drafter.draft()`** passes the cleaned body as **both** `bodyText` and the new `generatedBodyText` on `drafts.insert(...)`. `DraftInsert` gains `generatedBodyText: string`; `DraftsRepository.insert` writes the `generated_body_text` column.
- **`POST /drafts/:id/send`** (`api/drafts.ts`), after `markSent`: if `draft.generated_body_text` is non-null, compute `div = divergenceRatio(draft.generated_body_text, input.bodyText)`; when `div >= HEAVY_EDIT_THRESHOLD` (`0.30`), append:

  ```ts
  actions.append({
    actor: 'user',
    action: 'draft_heavily_edited',
    targetType: 'draft',
    targetId: id,
    details: { threadId: draft.thread_id, version: draft.version, divergencePct: Math.round(div * 100) },
  });
  ```

  **IDs + ratio only — no bodies** (BRIEF §5). The existing `draft_sent` entry is unchanged. Logged only on a successful `markSent` (not on failed/discarded sends). An offline Background-Sync replay re-POSTs `/send` → same path → logs once per actual send.

This closes the 6a deferral: because `generated_body_text` is never overwritten by the edit PATCH, the comparison is meaningful even though `body_text == final_body_sent` at send time.

### Sent-mail mining (Approach A: dedicated queue lane)

**Candidate selection — `MessagesRepository.recentOutbound(limit = 200)`:**

```sql
SELECT * FROM messages
WHERE direction = 'outbound' AND (is_draft IS NULL OR is_draft = 0)
  AND body_text IS NOT NULL AND TRIM(body_text) != ''
ORDER BY COALESCE(date_sent, date_received, 0) DESC
LIMIT ?
```

**`StyleExamplesRepository` additions:**

- `existsForMessage(messageId: string): boolean` — idempotency; a re-run skips already-mined messages regardless of status (so rejections stay sticky).
- `insertPending(input: { sourceMessageId: string; contactCategory: string | null; contextSummary: string; replyText: string; tags: string }): string` — `status='pending'`, `embedding` NULL, id via `randomUUID()`.
- `listByStatus(status: StyleExampleStatus): StyleExampleRow[]` and `listAll(): StyleExampleRow[]` — newest-first, for the review UI.
- `setStatus(id: string, status: StyleExampleStatus): void`.
- `update(id: string, fields: { contextSummary?: string; replyText?: string; tags?: string }): void`.
- `sample()` gains `AND status = 'approved'` on **both** the category query and the any-category fallback.

**`SentMailMiner` (`agent/SentMailMiner.ts`) — `mine(messageId): Promise<void>`, never throws (queue-safe, like `Drafter`/`Classifier`):**

1. `msg = messages.getById(messageId)`; skip if missing / `direction !== 'outbound'` / empty `body_text` / `is_draft`.
2. Skip if `styleExamples.existsForMessage(messageId)`.
3. `inbound = messages.latestInboundForThread(msg.thread_id)` — yields both the **context** (subject + truncated inbound snippet) and the **category**: `contacts.findByEmail(inbound.from_address)?.category ?? 'unknown'`. Fallback when no inbound: parse the first `to_addresses` recipient → `findByEmail` → category, else `'unknown'`. Mirrors `buildDraftPrompt`.
4. `{ system, prompt } = prompts.buildMiningPrompt({ subject, sentReply: msg.body_text, inboundContext })`.
5. `gateway.complete({ model, system, prompt, temperature: 0.2, max_tokens: 200 })` (model from `settings.get('llm.model')`, same default fallback as `Drafter`).
6. Parse the response as JSON `{ context_summary: string; tags: string[] }` via a zod schema. **On parse or gateway failure → skip** (count as failed; no row written; a later re-run retries the message).
7. `styleExamples.insertPending({ sourceMessageId: messageId, contactCategory, contextSummary: parsed.context_summary, replyText: msg.body_text.trim(), tags: JSON.stringify(parsed.tags) })`.
8. In a `finally`: `miningJob.tick()` + `eventBus.emit({ type: 'mining:progress', payload: { done, total } })` — fires for **every** enqueued id (mined or skipped), so `done` always reaches `total`.

The stored `replyText` is the trimmed sent body (no subject-strip needed — it is a real sent message, not an LLM completion); all LLM inputs are truncated inside `buildMiningPrompt`.

**Mining prompt — `PromptAssembler.buildMiningPrompt({ subject, sentReply, inboundContext }): { system: string; prompt: string }`:**

- **System:** instructs the model to extract the author's writing style from one sent email reply and output JSON `{ "context_summary": string, "tags": string[] }` — `context_summary` is 1–2 sentences describing the situation being responded to; `tags` are short style descriptors (e.g. `warm`, `concise`, `no-signoff`). No prose outside the JSON.
- **Prompt:** the truncated inbound context (subject + snippet) followed by the truncated sent reply. Truncation bounds (`SNIPPET_MAX`, `BODY_MAX`) reuse the assembler's existing constants.

**Wiring (`index.ts`):**

- `miningJob` — a small holder `{ running: boolean; total: number; done: number }` with `start(n)`, `tick()`, `finish()` (its own tiny module, e.g. `agent/MiningJob.ts`).
- `miner = new SentMailMiner(prompts, gateway, messages, contacts, styleExamplesRepo, miningJob, eventBus, log, settings)` (no `threads` dep — category resolves from the inbound sender's contact).
- `miningQueue = new SequentialQueue((id) => miner.mine(id).then(() => undefined))` — a third lane beside `classificationQueue` / `draftQueue`.

**API — `api/style.ts`, `registerStyleRoutes(app, deps)`:**

- `POST /style/mine` → if `gateway` is null, `503 gateway_unavailable`; if `miningJob.running`, `409`. Else select `recentOutbound(200)`, drop those where `existsForMessage`, enqueue each remaining id, `miningJob.start(enqueued)`, and `miningQueue.onIdle().then(() => miningJob.finish())`. When `enqueued === 0`, do **not** flip `running`. Returns `{ data: { enqueued, alreadyMined } }`.
- `GET /style/mining-status` → `{ data: { running, total, done } }` (covers a UI opened mid-run).
- **SSE:** the `eventBus` event union gains `{ type: 'mining:progress'; payload: { done: number; total: number } }`, emitted per message and once more on completion.

**GPU note:** the mining lane drains alongside the live draft/classify lanes (one call per lane), so a deliberate run shares the GPU with any live drafting. Acceptable for a one-time job; the runbook notes it is best run when idle.

### Review API + UI

**Review API (`api/style.ts`):**

- `GET /style/examples?status=pending` → `{ data: StyleExampleView[] }`. Omitting `status` returns all (newest-first). `pending` is the UI default.
- `PATCH /style/examples/:id` → body `{ status?: 'approved' | 'rejected' | 'pending'; contextSummary?: string; replyText?: string; tags?: string[] }` (zod, `.strict()`). One route covers approve / reject / edit: it calls `setStatus` and/or `update` for whichever fields are present (the route serializes `tags` to JSON), and returns the updated `StyleExampleView`. `404` if not found. No delete — reject is sticky.

**Shared types (`packages/shared-types/src/domain.ts`, rebuild the package after editing):**

```ts
export type StyleExampleStatus = 'pending' | 'approved' | 'rejected';
export interface StyleExampleView {
  id: string;
  sourceMessageId: string | null;
  category: ContactCategory | null;
  contextSummary: string;
  replyText: string;
  tags: string[];        // parsed from the stored JSON; [] on malformed
  status: StyleExampleStatus;
}
```

A `styleExampleView` mapper (`api/views.ts` or `api/style.ts`) maps `StyleExampleRow` → `StyleExampleView`, parsing `tags` defensively (→ `[]` on malformed JSON) and narrowing `category` to a `ContactCategory | null`.

**PWA (`apps/service/pwa`):**

- **Hooks (`src/api/hooks.ts`):** `useStyleExamples(status?)` (key `['style-examples', status]`); `useMiningStatus()` (key `['mining-status']`); `useMineSentMail()` (POST `/style/mine`); `usePatchStyleExample()` (PATCH `/style/examples/:id`, invalidates `['style-examples']`). The existing EventSource handler gains a `mining:progress` case → updates `['mining-status']` query data and, on completion (`done >= total`), invalidates `['style-examples']`.
- **Entry point:** the Settings "Voice / style guide" section (6a) gets a **"Review mined style examples →"** link to a new route `/voice/examples`, added to the `App.tsx` `Switch`.
- **Screen `src/routes/StyleExamples.tsx`** — list-with-actions, matching the NeedsAttention/Contacts card pattern:

  ```
  ┌─ Mined style examples ────────────────────────┐
  │  [ Mine sent mail ]       Mining 37 / 200 ▓▓░░ │   button disabled while running;
  │  (Pending)  Approved  Rejected                 │   progress from useMiningStatus + SSE
  ├────────────────────────────────────────────────┤
  │  [client] warm · concise · no-signoff          │   category badge + tags
  │  Context: Replying to a scheduling request…    │
  │  Reply: "Sounds good — Tuesday at 2 works…"    │   collapsible if long
  │            [ Approve ]  [ Reject ]  [ Edit ]    │
  ├────────────────────────────────────────────────┤
  │  [vendor] direct · brief …                      │
  └────────────────────────────────────────────────┘
  ```

  - **Mine sent mail** button → `useMineSentMail()`; disabled while `running`. Progress (`Mining {done} / {total}`) from `useMiningStatus()` + SSE.
  - **Filter tabs** Pending (default) / Approved / Rejected.
  - **Approve** / **Reject** → `PATCH { status }`. **Edit** toggles inline-editable `contextSummary` / `replyText` / `tags` → Save → `PATCH` those fields. Success invalidates the list (existing pattern; no optimistic update).
  - **Empty state:** "No mined examples yet — tap *Mine sent mail* to analyze your last 200 sent messages."
  - Approving takes effect immediately — `sample()` reads `status='approved'` live, no restart.

### Data flow

- **Heavy-edit:** `Drafter` writes `generated_body_text` at draft time → user edits via `PATCH` (only `body_text` changes) → on send, `divergenceRatio(generated_body_text, final)` ≥ 0.30 → `action_log 'draft_heavily_edited'` (ids + ratio).
- **Mining:** `POST /style/mine` → enqueue candidate ids → `SentMailMiner.mine` (one LLM call each) → `pending` `style_examples` rows + `mining:progress` SSE → review screen lists pending → `PATCH approve` → `sample()` includes it on the next draft.

### Error / edge cases

- No gateway → `503` on `POST /style/mine`. Job already running → `409`. Nothing to mine → `{ enqueued: 0 }`, `running` stays false, UI empty state.
- Per-message failure (gateway error / bad JSON) → skipped, counted, never throws (the `SequentialQueue` backstop logs); `tick()` still fires so progress completes.
- Re-run/resume → `existsForMessage` skips mined messages (any status); only new/failed re-enqueue.
- Heavy-edit: NULL `generated_body_text` (old drafts) → skip; both-empty → 0 → no log; only on successful `markSent`.
- `tags` parsed defensively in the view mapper → `[]` on malformed JSON.
- Editing/rejecting an approved example takes effect on the next draft `sample()`.

### Testing (BRIEF §18 — logic TDD, UI manual)

**Server (TDD via unit + `app.inject`):**

- `divergenceRatio`: identical → 0; full rewrite → ~1; one-word change in many → `< 0.30`; both-empty → 0; truncation cap honored.
- Heavy-edit on send (`app.inject` + fake provider): draft with `generated_body_text`, PATCH a large rewrite, send → `action_log` has `draft_heavily_edited` with `divergencePct` **and ids only, no body**; near-identical body → no entry; NULL `generated_body_text` → no entry, no crash.
- `MessagesRepository.recentOutbound`: outbound, non-empty, non-draft, newest-first, limit honored; excludes inbound/empty/`is_draft`.
- `StyleExamplesRepository`: `insertPending` → `listByStatus`/`listAll`; `existsForMessage`; `setStatus`; `update`; **`sample()` returns only `approved`** (category + fallback), a `pending` row is never sampled.
- `SentMailMiner.mine` (fake gateway): candidate → one `pending` row with parsed `context_summary`/`tags` + resolved category; skips already-mined / non-outbound / empty; gateway-throw or bad-JSON → no row, no throw, `tick()` still fires.
- `buildMiningPrompt`: carries truncated reply + inbound context; requests JSON.
- API (`app.inject`, injected fake `miningQueue`/`miner` for determinism): `POST /style/mine` enqueues + returns counts; `409` running; `503` no-gateway; `GET /style/mining-status`; `GET /style/examples?status=` filters; `PATCH` approve/reject/edit reflects in the view; `404`.

**PWA:** hooks typecheck against the DTOs; the `StyleExamples` screen + mine trigger/progress verified manually (runbook).

**Folded into 6b's manual pass:** the deferred **6a live UI spot-check** — the style-guide Save/Reset shapes a real draft; a contact's `style_notes` appears in its draft prompt.

## Out of scope (explicit)

- 6c sqlite-vec embedding retrieval (the `embedding` column stays unused).
- Multi-message mega-prompt mining; account-scoped mining; bulk approve/reject; deleting style examples.
- Surfacing heavy-edit analytics in the UI (the `action_log` entry is for later analysis only).
- Any change to the verified draft/offline send UX beyond adding the heavy-edit log.
