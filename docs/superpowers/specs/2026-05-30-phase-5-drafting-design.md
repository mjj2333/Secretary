# Phase 5 — Drafting + Review + Send — Design

**Date:** 2026-05-30
**Status:** Approved (pending spec review)
**Brief reference:** `BRIEF.md` §11 (drafting job), §6 (`drafts`/`style_examples` schema), §9 (drafts API), §14 Phase 5.

## Context

Phases 0–4 are complete and merged. `apps/service` has the encrypted SQLCipher DB with the full §6 schema, the Fastify server (bearer guard, `{data}`/`{error}` envelope, SSE + `EventBus`), `GatewayClient` (encrypted round-trip to the operator LLM), the `ImapProvider` + `SyncManager`, and the Phase 4 `agent/` layer: `Classifier`, `StateMachine`, `PromptAssembler` (its constructor already reserves a `ThreadsRepository` dep for this phase's draft prompt), `ClassificationQueue`, `FollowUpEngine`, plus the threads/contacts APIs.

Phase 5 adds the **drafting** half of the agent: an LLM writes a reply for threads that need one, the reply is reviewed/edited/sent through a versioned `drafts` workflow, and sending flips the thread to `awaiting_their_reply`. It hooks into the Phase 4 `Classifier` (the §11 "enqueue a draft job after classification" step that Phase 4 deferred).

There is **no React PWA yet** (Phase 2.5), so Phase 5 is driven and verified through the HTTP API (curl-able) and unit tests with the **fake `GatewayClient`** + a fake provider; real drafting is verified manually against the operator's Ollama.

### Resolved design decisions (some extend/deviate from the literal brief — `BRIEF.md` to be updated per §18)

1. **Manual `POST /drafts` is synchronous** — it awaits the LLM and returns the finished draft, rather than enqueuing + returning a 202. Simpler for the API consumer and for curl testing; the ~LLM latency (≈15s on the local 1.5B model) is acceptable for a personal tool. Only the **auto-draft** path (fired from the Classifier) is queued/async.
2. **`agent.autodraft_on_inbound` seed default → `false`** (the brief's default is `true`). The Classifier→draft hook is fully built; it just stays dormant until the setting is flipped on (e.g. when pointed at a larger model). The existing dev DB (seeded `true` in Phase 2) is flipped to `false` during setup/verification.
3. **Replies address the sender of the latest inbound message only** (not reply-all) in v1; subject is `Re: <subject>` (prefix added if absent); threading uses that message's `Message-ID`.
4. **Generalize the Phase-4 `ClassificationQueue` into a reusable `SequentialQueue`** used by both classification and drafting — one serial worker (the operator runs a single GPU). This replaces `ClassificationQueue` and adapts its test.
5. **`polish_diff` is computed now** — a small pure line-level diff between `raw_intent` and the polished `body_text`, stored as JSON on the draft (for the eventual PWA diff toggle).

## Goals (this phase)

1. `Drafter` + `prompts/drafter.md` + `prompts/voice-baseline.md` implementing the §11 drafting job.
2. `PromptAssembler.buildDraftPrompt(threadId, opts?)`.
3. `DraftsRepository` + `DraftRow`; a thin `StyleExamplesRepository` + `StyleExampleRow` (read-only, empty in v1).
4. `SequentialQueue` (generalized) used by both the classification and draft paths; auto-draft hook wired from the `Classifier`.
5. Draft API: `GET /drafts/:id`, `POST /drafts` (create/regenerate), `PATCH /drafts/:id` (edit), `POST /drafts/:id/send`, `DELETE /drafts/:id`.
6. Send wiring: `provider.sendMessage` with threading headers, `markSent`, `StateMachine.onOutbound`, action-log, SSE.
7. `draft:ready` SSE event on every new draft; action-log entries for draft created/sent/discarded.

## Non-goals (deferred)

- The PWA thread/draft review screens, raw-intent input, diff UI, long-press send confirm (Phase 2.5).
- **Web Push** on `draft:ready` (Phase 5.5). Phase 5 only emits the SSE event + writes the draft.
- `style_examples` mining / population (Phase 6). The few-shot block reads the (empty) table and falls back to none.
- The style-guide editor UI (Phase 6); Phase 5 loads the voice guide from `settings('style_guide')` if set, else the markdown file.
- Calendar-aware availability in drafts (Phase 9).
- Reply-all, attachment composition, multiple-recipient editing.

## Architecture

### Prompts — `apps/service/server/prompts/`

- `drafter.md` — system prompt: write a reply email in the principal's voice; honor tone/length targets; use the provided context and (optional) raw intent; **return only the email body — no preamble, no subject line, no quoted original**.
- `voice-baseline.md` — the default voice guide (concise, warm-professional baseline). Both ship in the `dist` build via the existing prompts-copy step.

### Prompt assembly — `PromptAssembler.buildDraftPrompt`

New method on the existing `PromptAssembler` (now using its `threads` + `contacts` + `messages` deps, plus a new `StyleExamplesRepository` dep and the prompts dir):

`buildDraftPrompt(threadId: string, opts?: { rawIntent?: string }): { system: string; prompt: string; systemPromptUsed: string }`

- Resolve the thread (`ThreadsRepository.get`) — throws `NotFoundError` if missing.
- Resolve the **target inbound message** = `MessagesRepository.latestInboundForThread(threadId)` — throws `ValidationError('No inbound message to reply to')` if none.
- `system` = `drafter.md` + `\n\n` + voice guide (`settings.get('style_guide')` if a non-empty string, else `voice-baseline.md`). `systemPromptUsed` returns the same string so the `Drafter` can persist it to `drafts.system_prompt_used`.
- `prompt` (context block), deterministic:
  - **Contact:** name, category, notes (≤500), style_notes (≤500 if present).
  - **Tone target** derived from contact category (e.g. `client_*` → warm-professional; `personal` → casual; `vendor`/`screening` → brief-professional). **Length target:** 1–3 short paragraphs.
  - **Few-shot:** up to 3 `style_examples` for the contact's category (fallback to any), each `context → reply`; omitted entirely when the table is empty.
  - **Thread history:** condensed — each prior message as `direction · from · ≤200-char snippet`; then the **inbound message being replied to in full** (body ≤4000 chars).
  - **Raw intent** (if provided): "The principal dictated this intent; polish it into the reply: <rawIntent>".
  - Closing instruction: "Write only the reply body."
- Caches the two markdown files like the classifier prompt does.

### Drafter — `agent/Drafter.ts`

Constructor deps: `PromptAssembler`, `GatewayClient | null`, `DraftsRepository`, `MessagesRepository`, `ThreadsRepository`, `ActionLogRepository`, `EventBus`, `SettingsRepository`, `MiniLogger`, `now = Date.now`.

`async draft(threadId: string, opts?: { rawIntent?: string }): Promise<DraftRow | null>` — never throws:

- If `GatewayClient` is null → log + return null (drafting disabled until setup).
- Build the prompt; `model = settings('llm.model') ?? DEFAULT_MODEL`; `temperature = settings('llm.temperature.draft') ?? 0.5`; `max_tokens` ≈ 800. Call `gateway.complete({ model, system, prompt, temperature, max_tokens })` (no `format:'json'` — free-text body).
- Body = trimmed `res.response` (strip any accidental leading "Subject:"/quoted lines defensively).
- Derive recipients from the target inbound message: `to = [sender]`, `subject = "Re: " + normalizedSubject` (no double `Re:`), `in_reply_to_message_id = <target message internal id>`, `account_id = thread.account_id`.
- `polish_diff = opts.rawIntent ? lineDiff(rawIntent, body) : null`.
- `DraftsRepository.insert({ threadId, accountId, version: nextVersion(threadId), inReplyToMessageId, to, cc: [], subject, bodyText: body, rawIntent, polishDiff, systemPromptUsed, modelUsed: res.model, tokensIn: res.tokens_in, tokensOut: res.tokens_out, latencyMs: res.duration_ms, status: 'pending_review', createdAt: now() })`.
- `action_log.append({ actor:'agent', action:'draft_created', targetType:'draft', targetId: <draftId>, details:{ threadId, version, regenerate: !!opts } })` (no body content).
- `eventBus.emit({ type:'draft:ready', payload:{ threadId, draftId, accountId } })`; return the row.
- On any gateway/error: log (metadata only), `action_log` `draft_failed`, return null. (No partial draft row written on failure — keeps the versions clean.)

### Diff util — `agent/draftDiff.ts`

`lineDiff(before: string, after: string): { op: 'eq'|'add'|'del'; line: string }[]` — a minimal LCS-based line diff returning an op-tagged sequence (JSON-serializable). Pure, fully unit-tested.

### Sequential queue — `agent/SequentialQueue.ts` (generalized from `ClassificationQueue`)

`new SequentialQueue(worker: (id: string) => Promise<void>)` with `enqueue(id)`, `size()`, `onIdle()`; FIFO, concurrency 1, in-flight dedup, throw-isolation with `console.error` (identical semantics to the Phase-4 `ClassificationQueue`, just parameterized on the worker fn). `ClassificationQueue` is removed; `index.ts` builds `new SequentialQueue((id) => classifier.classify(id))` and `new SequentialQueue((id) => { void drafter.draft(id); })`. The Phase-4 `classification-queue.test.ts` is rewritten as `sequential-queue.test.ts`.

### Repositories

- **`DraftsRepository`** (`db/repositories/DraftsRepository.ts`) + `DraftRow` in `schema.ts` (mirrors §6 `drafts`): `nextVersion(threadId)`, `insert(input): string` (returns id), `getById(id)`, `latestForThread(threadId)` (highest version, excluding discarded), `updateBody(id, { bodyText?, subject? })`, `markSent(id, { sentAt, finalBodySent })`, `markDiscarded(id)`, `markFailed(id)`.
- **`StyleExamplesRepository`** (`db/repositories/StyleExamplesRepository.ts`) + `StyleExampleRow`: `sample(category: ContactCategory, limit: number): StyleExampleRow[]` — category match then fallback to any; returns `[]` while the table is empty.

### Classifier auto-draft hook — `Classifier.ts` (modify)

- Add a `ContactsRepository` dep and an optional `onDraftEligible?: (threadId: string) => void`.
- After a successful `requires_response === true` classification (right after `applyClassification` + action-log), check: `settings.get('agent.autodraft_on_inbound') === true` **and** `contacts.findByEmail(message.from_address)?.do_not_auto_draft !== 1` → `onDraftEligible?.(threadId)`. The eligibility logic lives here (unit-tested); the queue wiring is the injected hook.

### API — `api/drafts.ts`

All under `/api/v1`, bearer-guarded, `{data}`/`{error}` envelopes. Deps: `{ db, drafter: { draft(threadId, opts?) }, providers: ProviderRegistry, stateMachine: { onOutbound(threadId) } }`.

- `GET /drafts/:id` → `DraftView` (404 if missing).
- `POST /drafts` — body `{ threadId, rawIntent?, regenerate? }` (zod `safeParse` → `ValidationError` on bad input). Runs `await drafter.draft(threadId, { rawIntent })` **synchronously**; if it returns null → `502 draft_failed` (gateway unconfigured or LLM error); else returns the new `DraftView`. (`regenerate` is informational — every `POST /drafts` already creates the next version.)
- `PATCH /drafts/:id` — body `{ bodyText?, subject? }`; 404 if missing; `DraftsRepository.updateBody`; returns the updated `DraftView`.
- `POST /drafts/:id/send` — load draft (404 if missing; `ValidationError` if already `sent`/`discarded`); resolve the account's provider (`providers.get(draft.account_id)`; `NotFoundError('Account not connected')` if absent); resolve the threading header (`MessagesRepository.getById(draft.in_reply_to_message_id)?.message_id_header`); build `SendInput` (`to`/`cc`/`subject`/`bodyText = draft.body_text`, `inReplyToMessageId = <that Message-ID header>`); `await provider.sendMessage(input)`; `markSent(id, { sentAt: now, finalBodySent: body_text })`; `stateMachine.onOutbound(draft.thread_id)`; `action_log` `draft_sent` (no body); SSE `thread:updated`; return `{ data: { providerMessageId, threadState: 'awaiting_their_reply' } }`. On `sendMessage` throw → `markFailed` + `502 send_failed`.
- `DELETE /drafts/:id` — `markDiscarded`; `action_log` `draft_discarded`; `{ data: { discarded: true } }`.

`DraftView` (new in `shared-types/domain.ts`): `{ id, threadId, accountId, version, to, cc, subject, bodyText, rawIntent, polishDiff, status, modelUsed, createdAt, sentAt }` (ISO dates; addresses as `EmailAddress[]`; `polishDiff` the diff array or null).

### Server wiring — `server.ts` + `index.ts`

- `ServerDeps` gains `drafter` (for the route's synchronous create) and reuses `providers` + `stateMachine`. Register `registerDraftsRoutes(api, deps)` in the `/api/v1` block.
- `index.ts`: build `StyleExamplesRepository`, `DraftsRepository`; extend `PromptAssembler` construction with the style-examples dep; build `Drafter`; build the draft `SequentialQueue`; wire the `Classifier`'s `onDraftEligible` → `draftQueue.enqueue`; replace the `ClassificationQueue` construction with `SequentialQueue`. The auto-draft path stays dormant while `autodraft_on_inbound` is `false`.
- `seed.ts`: `agent.autodraft_on_inbound` default → `false`.

## Data flow

**Auto (when `autodraft_on_inbound=true`):** classify → `requires_response=true` + contact not `do_not_auto_draft` → `onDraftEligible` → `draftQueue.enqueue(threadId)` → `Drafter.draft` → `drafts` row + SSE `draft:ready`.

**Manual:** `POST /drafts {threadId, rawIntent?}` → `await Drafter.draft` → returns the draft. **Edit:** `PATCH` → `updateBody`. **Send:** `POST /drafts/:id/send` → translate internal `in_reply_to_message_id` → RFC `Message-ID` → `provider.sendMessage` → `markSent` + `StateMachine.onOutbound` (→ `awaiting_their_reply` + SLA) → SSE. The sent copy also re-syncs from the Sent folder later (idempotent: state already `awaiting_their_reply`).

## Error handling

- **Gateway unconfigured/null** → `Drafter.draft` returns null; auto path is a no-op (logged); manual `POST /drafts` → `502 draft_failed`.
- **Draft LLM error** → caught, `draft_failed` action-log, null returned; no partial row.
- **Send failure** (`provider.sendMessage` throws) → `markFailed` + `502 send_failed`; thread state unchanged (no false `awaiting_their_reply`).
- **Queue isolation** → the draft worker (`drafter.draft`) never throws; `SequentialQueue` also guards with `console.error`.
- New thrown API errors reuse `NotFoundError` (404) / `ValidationError` (400); add an `UpstreamError`-based `draft_failed`/`send_failed` (502) via the existing `UpstreamError` class (code argument). No bodies/prompts/completions logged (§5) — action-log details carry only ids/enums/version numbers.

## Testing strategy

Vitest; fake `GatewayClient` (free-text response) + fake provider; real migrated temp DB.

- **`draftDiff`** — eq/add/del across insert/delete/replace cases.
- **`PromptAssembler.buildDraftPrompt`** — system = drafter.md + voice guide (and the `style_guide` setting override path); context includes contact + thread history + the full inbound body (truncation) + raw intent; few-shot empty → omitted; `NotFoundError`/no-inbound `ValidationError`.
- **`Drafter`** — success writes a `pending_review` row with derived `to`/subject/`in_reply_to_message_id` + `model_used`/tokens/latency + SSE `draft:ready` + `draft_created` log; `rawIntent` populates `polish_diff`; a second call bumps `version`; gateway null → null + no row; gateway throw → `draft_failed` + null.
- **`SequentialQueue`** — the rewritten Phase-4 queue tests (FIFO, concurrency 1, dedup, onIdle, throw-isolation, enqueue-mid-drain).
- **`Classifier` auto-draft hook** — `onDraftEligible` fires when `requires_response` + `autodraft_on_inbound=true` + contact not `do_not_auto_draft`; does NOT fire when any condition fails or when `requires_response=false`.
- **`DraftsRepository`** — version increment, insert/getById/latestForThread (excludes discarded), updateBody, markSent/markDiscarded/markFailed.
- **API** (`app.inject`, fake gateway + fake provider): `POST /drafts` (synchronous create returns the draft; bad body 400; gateway-fail 502), `PATCH` (edit; 404), `POST /drafts/:id/send` (sends edited body, sets threading header from the replied-to `Message-ID`, flips thread to `awaiting_their_reply`, already-sent 400, missing-provider 404, send-fail 502), `DELETE` (discard), `GET` (view; 404).
- **Manual interop** (`docs/PHASE-5-MANUAL-VERIFICATION.md`): point the gateway at Ollama; ensure `autodraft_on_inbound=false`; `POST /drafts` on an `awaiting_your_reply` thread → `GET` it → `PATCH` an edit → `POST /send` → confirm it arrives in Gmail and the thread flips to `awaiting_their_reply`; then flip `autodraft_on_inbound=true`, re-classify a thread, and confirm an auto-draft appears.

## Acceptance criteria (BRIEF §14 Phase 5) → how met

| Criterion                                                                       | Met by                                                                                                        |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| New inbound (requires_response, not do-not-draft) generates a draft within ~15s | Classifier `onDraftEligible` → draft queue → `Drafter` (gated by `autodraft_on_inbound`); manual + auto tests |
| Draft sent successfully via the provider                                        | `POST /drafts/:id/send` → `provider.sendMessage`; route test + manual                                         |
| After send, thread → `awaiting_their_reply` with new SLA                        | `StateMachine.onOutbound` in the send route; test asserts state + SLA                                         |
| Editing a draft inline and sending uses the edited version                      | `PATCH` updates `body_text`; send uses current `body_text`; route test                                        |

## Risks & mitigations

- **Small-model draft quality** (`qwen2.5:1.5b`) — drafts will be rough; the pipeline is correct and improves with a larger model (model is a setting). The drafter prompt instructs "body only" + defensive stripping of stray `Subject:`/quotes.
- **Synchronous `POST /drafts` latency** — ~15s on the local model; acceptable for v1/curl; the PWA will show a spinner. Auto path is async so it never blocks sync.
- **Threading-header translation** — `in_reply_to_message_id` is our internal id; the send route maps it to the message's `Message-ID` header (the only value `nodemailer` can thread on). Tested.
- **Queue generalization churn** — replacing `ClassificationQueue` re-touches Phase-4 wiring + one test; behavior is identical and covered by the rewritten test.
- **Native-module ABI** — tests/`dev:server` need the Node ABI build (unchanged gotcha).
