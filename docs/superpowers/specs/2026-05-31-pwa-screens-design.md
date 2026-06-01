# Secretary PWA — Designed Screens (Needs Attention + Draft Review) Design

**Date:** 2026-05-31
**Status:** Approved design, ready for implementation plan
**Builds on:** Phase 2.5 PWA foundation (shell, routing, API client, query hooks, SSE plumbing) and Phase 5 drafting/send.

## Overview

Replace the Phase 2.5 **placeholder route bodies** with the two real, designed screens of the mobile-first PWA:

1. **Needs Attention** (`/needs-attention`) — sender-led cards for threads requiring a reply, each surfacing whether a draft exists.
2. **Thread / draft review** (`/threads/:id`) — the conversation plus the editable agent draft with the full review→edit→send loop, wiring the Phase-5 drafts API.

This also closes a real **API gap**: the service does not currently expose "the current draft for a thread" or a friendly sender name to the client. Both screens depend on small server enrichments (below).

## Scope

**In scope:**

- Needs Attention cards (sender name, time-ago, urgency, subject, agent summary, draft affordance).
- Thread/draft-review screen: conversation (latest inbound expanded, tap to collapse/expand), editable draft, sticky action bar.
- Draft loop: **Generate** (when none), **Regenerate**, **Edit** (inline textarea), **Send** (with a confirm step), **Discard**.
- **Diff toggle** (scope item A): show `polish_diff` (raw intent → polished body).
- **Edit-raw-intent + regenerate** (scope item B): enter/replace the raw intent and regenerate.
- Server enrichments: `currentDraft` on `GET /threads/:id`; `hasDraft` + `senderName` on needs-attention items; `senderName` on the thread detail.

**Deferred (not this phase):**

- Swipe gestures on cards (right = handle manually, left = snooze) — BRIEF §12.
- Voice input (SpeechRecognition) for the raw intent — BRIEF §12.
- Offline send-queue / runtime API caching — Phase 5.5.
- Inbox / Contacts / Settings / Follow-ups redesigns — those keep their Phase-2.5 placeholder bodies for now.

## Deviations from BRIEF §12 (record in the spec + BRIEF)

- **Send confirmation is a tap-to-confirm bottom sheet**, not the BRIEF's _long-press → modal_. Long-press is awkward/uncommon on desktop and easy to mis-trigger; a tap-to-confirm sheet gives the same accidental-send protection cross-platform.
- Swipe gestures and voice input are deferred (above).

---

## Architecture

### Data flow

- The PWA reads everything through the existing typed `apiFetch` + TanStack Query hooks. The SSE layer already invalidates `['needs-attention']` and `['thread', id]` on `thread:updated` / `draft:ready`, so generated/regenerated drafts and state changes appear live with no new wiring.
- **One request per screen**: cards come from `GET /threads/needs-attention`; the thread screen's conversation **and** current draft come from a single `GET /threads/:id`.

### Server enrichments (`apps/service`)

**1. Shared "active draft" predicate.** A draft is the thread's _current/reviewable_ draft when its status ∈ `{ pending_review, editing, failed }` (i.e. not `sent`/`discarded`). `failed` = a send that failed and is re-sendable. Implement once (e.g. a small helper in `DraftsRepository`, `currentForThread(threadId): DraftRow | undefined`, built on the existing `latestForThread` + status filter).

**2. `senderName` resolution.** For a thread, the sender = the latest **inbound** message's `from` (`MessagesRepository.latestInboundForThread`). Resolve to a friendly name: `ContactsRepository.findByEmail(fromAddress)?.display_name` → else the message's `from_name` → else the raw email address. Expose as `senderName: string`. Fallback when a thread has no inbound message (rare — needs-attention threads always have one): the first thread participant, else the subject, else `"Unknown"`.

**3. DTO additions** (`packages/shared-types/src/domain.ts`):

- `NeedsAttentionItem` (extends `ThreadSummary`): add `senderName: string` and `hasDraft: boolean`.
- `ThreadWithMessages` (extends `ThreadSummary`): add `senderName: string` and `currentDraft: DraftView | null`.
- (`DraftView` already exists with `polishDiff: DiffOp[] | null`, `version`, `status`, `bodyText`, `subject`, `rawIntent`, `to`, etc. — no change.)

**4. Endpoint enrichment** (`apps/service/server/api/threads.ts`):

- `needsAttentionItem(row)` mapper → also set `senderName` (resolve from latest inbound + contacts) and `hasDraft` (current-draft predicate). The needs-attention list is small (bounded set of threads needing attention), so per-row lookups via the existing repo methods are acceptable; a query-level `EXISTS`/join is an allowed optimization but not required.
- `GET /threads/:id` handler → add `senderName` and `currentDraft: currentForThread(id) ? draftView(row) : null` to the `ThreadWithMessages` response. (`draftView` already exists in `drafts.ts`; extract/share it or duplicate the small mapper — implementation detail for the plan.)

No new endpoints, no change to `POST /drafts`, `PATCH /drafts/:id`, `POST /drafts/:id/send`, `DELETE /drafts/:id`, or the auth/SSE layers.

### PWA (`apps/service/pwa`)

**Query/mutation hooks** (`src/api/hooks.ts`, extend the existing file):

- `useThread(id)` — already returns `ThreadWithMessages`; now includes `currentDraft` + `senderName` (no signature change).
- `useNeedsAttention()` — items now include `hasDraft` + `senderName` (no signature change).
- `useGenerateDraft()` / `useRegenerateDraft()` — `POST /drafts` with `{ threadId }` (generate) or `{ threadId, rawIntent?, regenerate: true }` (regenerate). `onSuccess` invalidate `['thread', threadId]` (+ `['needs-attention']`). (Supersedes the foundation's `useCreateDraft`.)
- `useEditDraft()` — `PATCH /drafts/:id` `{ bodyText?, subject? }`; `onSuccess` invalidate `['thread', threadId]`.
- `useSendDraft()` — exists (`POST /drafts/:id/send`); `onSuccess` invalidate `['needs-attention']` + `['thread', threadId]`.
- `useDiscardDraft()` — `DELETE /drafts/:id`; `onSuccess` invalidate `['thread', threadId]` + `['needs-attention']`.

**Components / files:**

- `src/routes/NeedsAttention.tsx` — rewrite from placeholder to the card list (loading/error/empty states preserved).
- `src/components/NeedsAttentionCard.tsx` — one card (sender name, time-ago, `UrgencyPill`, subject, summary, draft action). Tap card → `setLocation('/threads/'+id)`; "Generate draft" → `useGenerateDraft` then route into the thread.
- `src/routes/ThreadView.tsx` — rewrite from placeholder to the conversation + draft panel.
- `src/components/MessageList.tsx` / `MessageItem.tsx` — conversation; latest inbound expanded by default, others collapsed (tap to toggle).
- `src/components/DraftPanel.tsx` — the editor: textarea (local state seeded from `currentDraft.bodyText`), version label, intent line, **diff toggle**, **edit-intent** input, sticky action bar `[Regenerate] [Edit intent] [Send]`. When `currentDraft` is null → a centered **"Generate draft"** CTA (spinner while generating).
- `src/components/SendConfirmSheet.tsx` — tap-to-confirm bottom sheet ("Send this draft as-is?" + recipient/subject + Cancel/Send).
- `src/components/DiffView.tsx` — renders `DiffOp[]` (eq plain / add green / del red, strikethrough).
- `src/components/UrgencyPill.tsx` — urgency → colored pill (high=red, normal=amber, low=slate; null=hidden).
- `src/util/timeAgo.ts` — `formatTimeAgo(iso: string | null): string` ("2h", "1d", "just now").

### Key interactions

- **Generate** (no draft): `POST /drafts {threadId}` → spinner → on success the SSE `draft:ready` (and the mutation's invalidation) refreshes `['thread', id]`, the editor appears. On 502 (`draft_failed`, gateway down) → inline error + retry.
- **Edit**: textarea is local React state. **Send saves first** — `PATCH /drafts/:id {bodyText, subject}` then `POST /drafts/:id/send`, so what's on screen is what sends. (Optional debounced autosave is out of scope; save-on-send is the contract.)
- **Regenerate**: `POST /drafts {threadId, regenerate:true}` (uses the prior raw intent if present). If the textarea has unsaved manual edits, confirm before discarding them (they'd be replaced by the new version).
- **Edit intent**: "Edit intent" reveals an input pre-filled with `currentDraft.rawIntent`; "Regenerate with this" → `POST /drafts {threadId, rawIntent}`.
- **Diff toggle**: toggles `DiffView` over the body using `currentDraft.polishDiff`; disabled when `polishDiff` is null (no raw intent).
- **Send**: opens `SendConfirmSheet`; confirm → save-then-send → on success route back to `/needs-attention` (the card is gone, thread is `awaiting_their_reply`); on 502 (`send_failed`) → error banner, draft stays (status `failed`, re-sendable), thread unchanged.
- **Discard**: `DELETE /drafts/:id` → `currentDraft` becomes null → editor returns to the "Generate draft" state.

### Error / empty / loading states

- Each screen keeps the foundation's `isLoading` / `error` / empty handling.
- Generate/Regenerate/Send in flight → disable the action bar + show a spinner on the active button.
- Mutation failures surface an inline message (the `ApiError.message`); they never navigate away.
- Offline: calls fail to their error state (no offline queue this phase — Phase 5.5).

### Testing strategy (per BRIEF §18 — UI manually verified in v1)

- **Server (TDD via `app.inject`)**: `GET /threads/:id` returns `currentDraft` (the active draft; `null` when the latest is sent/discarded or none exists) + `senderName`; needs-attention items carry `hasDraft` + `senderName` (contact `display_name`, then `from_name`, then email). Cover the "latest draft is sent → currentDraft null" and "failed draft → currentDraft present" cases.
- **PWA (Vitest + jsdom, TDD the pure logic)**: `formatTimeAgo`; `DiffView`/`UrgencyPill` light render assertions are optional, not required.
- **PWA screens/interactions**: manually verified via a runbook (`docs/PHASE-2.5b-MANUAL-VERIFICATION.md` or similar) — generate/regenerate/edit/diff/send-confirm/discard end-to-end against the live service, plus the live SSE refresh.
- Whole-workspace `pnpm -r test` / `typecheck` / `lint` / builds green; central ESLint still scopes out the PWA src (typecheck-covered).

## Out of scope (explicit)

- Swipe gestures, voice input (BRIEF §12 polish — later).
- Offline send-queue + runtime API caching (Phase 5.5).
- Push notifications (Phase 5.5).
- Inbox/Contacts/Settings/Follow-ups redesign (keep placeholders).
- Multi-account draft routing UI, attachment handling, CC editing (not in the Phase-5 API surface).
