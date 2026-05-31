# Phase 4 — Classification + State Machine + Follow-ups — Design

**Date:** 2026-05-30
**Status:** Approved (pending spec review)
**Brief reference:** `BRIEF.md` §11 (sync/classification/state rules), §6 (schema), §9 (API), §14 Phase 4.

## Context

Phases 0–3 are complete and merged: `apps/service` has the encrypted SQLCipher DB with the full §6 schema, the Fastify server (`buildServer` + bearer guard + `{error}` envelope + SSE scaffold + `EventBus`), `GatewayClient` (encrypted round-trip to the operator LLM, verified end-to-end in Phase 2), the `ImapProvider` + `SyncManager` (90-day sync, IDLE watch, persist into messages/threads/contacts/action_log), and repositories for Messages/Threads/Contacts/ActionLog/Settings/PushSubscription.

Phase 4 is the first phase that runs the **LLM on synced mail**. It adds an `agent/` layer that:

1. **Classifies** inbound threads via the gateway (`PromptAssembler` → `classifier.md` → `GatewayClient.complete`).
2. Drives the **thread state machine** (`needs_classification → awaiting_your_reply / awaiting_their_reply / informational / closed / scheduled_followup`) with **SLA deadlines** computed from settings + contact category.
3. Runs a **follow-up engine** (5-min cron) that flags SLA breaches as `follow_ups` rows.
4. Exposes **`GET /threads/needs-attention`**, plus thread state-override / re-classify endpoints and a contacts API whose category override retunes future SLAs.

There is **no React PWA yet** (Phase 2.5 was skipped), so Phase 4 is driven and verified through the HTTP API (curl-able) and unit tests with a **fake `GatewayClient`** — the real LLM classification is verified manually against the operator's Ollama, mirroring how Phase 2 tested the gateway and Phase 3 tested the provider.

### Resolved design decisions (extend/deviate from the literal brief — `BRIEF.md` to be updated per §18)

1. **Classify per-thread, by its latest message — not per inbound message.** Thread state is a function of the thread's _newest_ message, so we make exactly one state determination per thread per sync batch. This is more correct than the brief's literal "per inbound message": on the 90-day backlog it avoids applying superseded/out-of-order transitions, and it removes the race between a synchronously-applied outbound transition and an asynchronously-applied inbound classification. It also cuts LLM calls from per-message to ~per-thread.
2. **SLA deadline is anchored to the relevant message timestamp**, not "now": `awaiting_your_reply` → `last_inbound_at + slaHours`; `awaiting_their_reply` → `last_outbound_at + slaHours`. So genuinely-overdue backlog threads surface immediately. **Consequence:** the first backlog sync can generate many `sla_breach` follow-ups at once — accepted (they _are_ overdue; Web Push isn't wired until Phase 5.5, so follow-ups only create rows + emit SSE).
3. **`category_suggestion` is advisory only** — recorded in `action_log` details, **not** auto-applied to the contact's `category` (which drives SLA). Category remains manual (Phase 4 item 6), so a small model's guess can't silently retune SLAs.
4. **Classification execution is an in-process, sequential async queue.** One LLM call at a time (good citizen to the operator's single GPU running `keep_alive:0`). Durable recovery marker = the thread's `needs_classification` state; on startup we re-enqueue all such threads.
5. **The PWA "Needs Attention" view (Phase 4 item 5) is deferred** to whenever the PWA is built (Phase 2.5). Phase 4 ships the API that screen will consume.

## Goals (this phase)

1. `Classifier` + `prompts/classifier.md` implementing the §11 classification job (assemble → complete → validate → retry once → apply transition / mark `needs_classification`).
2. Pure `StateMachine`: §11.1 transition table (extended for the `needs_classification` start state) + SLA computation from settings + contact category.
3. In-process sequential `ClassificationQueue`; `SyncManager` routes each touched thread (by latest message) to outbound-transition (sync) or classify (async); startup recovery of `needs_classification` threads.
4. `FollowUpEngine` 5-min cron: SLA-breach detection → `follow_ups` rows + SSE.
5. `GET /api/v1/threads/needs-attention`; `POST /api/v1/threads/:id/state`; `POST /api/v1/threads/:id/classify`.
6. Contacts API: `GET /contacts`, `GET /contacts/:id`, `PATCH /contacts/:id` (category override → future SLAs).
7. Action-log entry for every classification, state transition, and follow-up.

## Non-goals (deferred)

- Agent **drafting** + the `drafts` table workflow (Phase 5). Classification only produces `requires_response`; it does **not** enqueue a draft job (that hook lands in Phase 5).
- **Web Push** delivery on SLA breach / draft-ready (Phase 5.5). Phase 4's follow-up engine creates rows + emits SSE only.
- The React PWA **Needs Attention** screen and the rest of the PWA (Phase 2.5).
- `follow_ups` API surface beyond what's needed here: this phase ships the `FollowUpsRepository` + engine; the `GET/POST /followups` endpoints (§9) are not required by Phase 4's acceptance and are deferred unless trivial.
- Auto-applying `category_suggestion`, CONDSTORE delta sync, batching the heavy backlog fetch (existing tech debt, unchanged).

## Architecture

### New shared types — `packages/shared-types/src/domain.ts`

Add the classification + view types (re-exported from `index.ts`):

- `ClassificationIntent` = `'inquiry' | 'booking_request' | 'scheduling' | 'chitchat' | 'question' | 'complaint' | 'other'`.
- `ClassificationResult` — `{ intent: ClassificationIntent; category_suggestion: ContactCategory; urgency: Urgency; requires_response: boolean; summary: string }`.
- `NeedsAttentionItem extends ThreadSummary` — adds `urgency: Urgency | null`, `slaDeadline: string | null` (ISO), `summary: string | null` (the thread's `last_agent_summary`), `hasPendingFollowUp: boolean`.
- `ContactView` — `{ id, emailAddress, displayName, category, notes, doNotAutoDraft, totalMessagesIn, totalMessagesOut, lastContactAt }` (ISO dates).

### Classification schema — `apps/service/server/agent/classificationSchema.ts`

- `classificationResultSchema` (zod) matching `ClassificationResult` (enums match the §6 / domain unions; `summary` `.max(140)` but tolerant — truncate rather than reject; `requires_response` coerced from common stringy LLM outputs `"true"/"false"`).
- `CLASSIFICATION_JSON_SCHEMA` — the JSON-schema object passed to `GatewayClient.complete({ json_schema })` (advisory; we still validate with zod + retry regardless of whether the gateway forwards it to Ollama).
- `parseClassification(raw: string): ClassificationResult | null` — strips code fences / leading prose, `JSON.parse`, zod-validate, clamp `summary` to 140 chars; returns `null` on any failure.

### Prompt assembly — `apps/service/server/agent/PromptAssembler.ts`

- Constructor deps: `MessagesRepository`, `ThreadsRepository`, `ContactsRepository`, and a `promptsDir` (defaults to `server/prompts`, resolved via `import.meta.url`).
- `private loadClassifierSystem()` — reads `classifier.md` once and caches it (module-level or instance cache).
- `buildClassificationPrompt(messageId: string): { system: string; prompt: string }`:
  - Loads the target message (`MessagesRepository.getById`) — throws `NotFoundError` if missing.
  - `system` = `classifier.md` content.
  - `prompt` (user context block), built deterministically:
    - **Contact:** the sender (`message.from_address`); `ContactsRepository.findByEmail`. Emit `name`, `category`, and `notes` truncated to 500 chars.
    - **Recent thread context:** `MessagesRepository.listByThread`, take the up-to-3 messages _before_ the target (chronological), each rendered as `direction · from · <=200-char snippet>`.
    - **New message:** `subject` + `bodyText` truncated to 2000 chars (with a `…[truncated]` marker).
    - Closing instruction: "Return ONLY a JSON object with keys intent, category_suggestion, urgency, requires_response, summary." (The stricter retry preamble is prepended by the `Classifier`, not here.)
- Pure given the repositories (no LLM, no network) → unit-testable against the temp DB.

### Classifier — `apps/service/server/agent/Classifier.ts`

- Constructor deps: `PromptAssembler`, `GatewayClient | null` (null = gateway not configured), `StateMachine`, `ThreadsRepository`, `MessagesRepository`, `ActionLogRepository`, `EventBus`, `SettingsRepository`, `now: () => number = Date.now`, `logger`.
- `async classify(messageId: string): Promise<void>` (never throws — self-contained, safe for the queue):
  1. If `GatewayClient` is null → log "gateway not configured, skipping classification", leave the thread `needs_classification`, return.
  2. `const { system, prompt } = promptAssembler.buildClassificationPrompt(messageId)`.
  3. `model` = `settings.get('llm.model') ?? DEFAULT_MODEL`; `temperature` = `settings.get('llm.temperature.classify') ?? 0.1`.
  4. First attempt: `gateway.complete({ model, system, prompt, temperature, format: 'json', json_schema: CLASSIFICATION_JSON_SCHEMA, max_tokens: 300 })` → `parseClassification(res.response)`.
  5. On `null`, retry **once** with a stricter system preamble (`STRICT_JSON_PREAMBLE + "\n\n" + system`) and the same user prompt.
  6. On second failure: `action_log.append({ actor:'agent', action:'classification_failed', targetType:'thread', targetId: threadId })`, ensure thread state stays `needs_classification`, emit `thread:updated`, return.
  7. On success: resolve `threadId` from the message; load the thread; compute `newState`/`urgency`/`sla` via `StateMachine.onInboundClassified(thread, result, message)`; `ThreadsRepository.applyClassification(threadId, { state, urgency, summary: result.summary, slaDeadline, stateChangedAt: now(), stateReason: 'classified' })`; `action_log.append({ actor:'agent', action:'classified', targetType:'thread', targetId: threadId, details:{ intent, urgency, requires_response, category_suggestion } })`; `eventBus.emit({ type:'thread:updated', payload:{ threadId, accountId } })`.
- Gateway/transport errors (thrown `SecretaryError` from `GatewayClient`) are caught, logged (metadata only), thread left `needs_classification`, `classification_failed` logged — same as a parse failure.

### State machine — `apps/service/server/agent/StateMachine.ts`

Pure transition + SLA logic, plus thin repo-update helpers. Constructor deps: `ThreadsRepository`, `ContactsRepository`, `SettingsRepository`, `ActionLogRepository`, `EventBus`, `now`.

**Pure transition** `nextStateForInbound(prev: ThreadState, requiresResponse: boolean): ThreadState`:

| prev                   | requires_response=true         | requires_response=false           |
| ---------------------- | ------------------------------ | --------------------------------- |
| `needs_classification` | `awaiting_your_reply`          | `informational`                   |
| `awaiting_their_reply` | `awaiting_your_reply`          | `informational`                   |
| `awaiting_your_reply`  | `awaiting_your_reply`          | `awaiting_your_reply` (unchanged) |
| `informational`        | `awaiting_your_reply`          | `informational` (unchanged)       |
| `scheduled_followup`   | `awaiting_your_reply`          | `scheduled_followup` (unchanged)  |
| `closed`               | `awaiting_your_reply` (reopen) | `closed` (unchanged)              |

`nextStateForOutbound(): ThreadState` → always `awaiting_their_reply`.

**Pure SLA** `computeSlaDeadline(state, contactCategory, thread): number | null`:

- `awaiting_your_reply` → `(thread.last_inbound_at ?? now) + slaHours(category) * 3_600_000`, where `slaHours` reads `agent.sla.<category>.awaiting_your_reply_hours` (settings: `client_established`=12, `client_new`=4) with **code fallback `DEFAULT_AWAITING_YOUR_REPLY_HOURS = 24`** for any other category / missing key.
- `awaiting_their_reply` → `(thread.last_outbound_at ?? now) + (agent.sla.default.awaiting_their_reply_hours ?? 72) * 3_600_000`.
- `needs_classification`, `informational`, `closed`, `scheduled_followup` → `null`.

**Compute (no write):**

- `onInboundClassified(thread, result, message)` → returns `{ state, urgency, slaDeadline }` for the `Classifier` to persist (the Classifier owns the single write + action_log + SSE, so the result-application stays in one place). `state = nextStateForInbound(thread.state, result.requires_response)`; `urgency = result.urgency`; category for SLA = the sender's contact category (`ContactsRepository.findByEmail(message.from_address)?.category ?? 'unknown'`); `slaDeadline = computeSlaDeadline(state, category, thread)`.

**Helpers (write directly — used for non-LLM transitions):**

- `onOutbound(threadId)` → loads thread, sets `state='awaiting_their_reply'`, `slaDeadline = computeSlaDeadline('awaiting_their_reply', _, thread)`, `state_changed_at = now`, `state_reason='outbound_sent'`, `urgency` left as-is; `action_log.append({actor:'system', action:'state_outbound'})`; `eventBus.emit('thread:updated')`. Synchronous (no LLM).
- `onManual(threadId, state, reason?)` → sets state (`closed`/`scheduled_followup`/any valid), recomputes/clears SLA accordingly, `action_log.append({actor:'user', action:'state_override', details:{state, reason}})`, emit SSE.

### Classification queue — `apps/service/server/agent/ClassificationQueue.ts`

- In-process FIFO of `messageId`s with a `Set` of in-flight/queued IDs to dedup.
- `enqueue(messageId: string): void` — ignore if already queued/in-flight; push; kick the drain loop if idle.
- Private `drain()` — sequential: shift one, `await classifier.classify(id)` (never throws), repeat until empty. A single worker (concurrency 1).
- `size()` for tests/observability; optional `onIdle()` promise to let tests await completion.
- No timers; purely event-driven by `enqueue`.

### Follow-up engine — `apps/service/server/agent/FollowUpEngine.ts`

- Constructor deps: `ThreadsRepository`, `FollowUpsRepository`, `ActionLogRepository`, `EventBus`, `now`.
- `runOnce(): number` — deterministic; returns count created:
  - `ThreadsRepository.findSlaBreaches(now())` → threads where `sla_deadline IS NOT NULL AND sla_deadline < now AND state IN ('awaiting_your_reply','awaiting_their_reply')` **and** no `follow_ups` row with `status='pending'` for that thread (`FollowUpsRepository.hasPending(threadId)` / done in one SQL `NOT EXISTS`).
  - For each: `FollowUpsRepository.insert({ threadId, triggerAt: now, reason:'sla_breach', status:'pending', createdAt: now })`; `action_log.append({actor:'system', action:'followup_created', targetType:'thread', targetId: threadId, details:{reason:'sla_breach'}})`; `eventBus.emit({type:'thread:updated', payload:{threadId}})`.
- `start(intervalMs = 5 * 60_000)` — `setInterval(() => this.runOnce(), intervalMs)`, `unref()` so it never blocks shutdown; `stop()` clears it. Thin wrapper; logic lives in `runOnce`.

### DB — repositories (`apps/service/server/db/repositories/`)

- **`FollowUpsRepository.ts` (new):** `insert(input)`, `hasPending(threadId): boolean`, `listPending(): FollowUpRow[]`, `dismiss(id)`, `resolve(id)`. Add `FollowUpRow` to `schema.ts`.
- **`MessagesRepository.ts` (modify):**
  - `insert(...)` returns the **new message id** (`string`) instead of `boolean`. It generates the uuid, runs `INSERT OR IGNORE`, returns the uuid. (`SyncManager.persist` already guards with `existsByProviderId`, so the row is always inserted there.)
  - Add `getById(id): MessageRow | undefined`.
  - Add `latestInboundForThread(threadId): MessageRow | undefined` (`WHERE thread_id=? AND direction='inbound' ORDER BY COALESCE(date_received,0) DESC LIMIT 1`).
- **`ThreadsRepository.ts` (modify):** add
  - `applyClassification(id, { state, urgency, summary, slaDeadline, stateChangedAt, stateReason })` — single UPDATE of `state, urgency, last_agent_summary, sla_deadline, state_changed_at, state_reason`.
  - `setState(id, { state, slaDeadline, stateChangedAt, stateReason })` — for outbound/manual transitions (no summary/urgency change).
  - `findNeedsClassification(): ThreadRow[]` — `WHERE state='needs_classification'` (startup recovery).
  - `findSlaBreaches(now): ThreadRow[]` — the §11 follow-up query (with `NOT EXISTS pending follow_up`).
  - `needsAttention(): ThreadRow[]` — `WHERE state='awaiting_your_reply' OR id IN (SELECT thread_id FROM follow_ups WHERE status='pending')`, ordered `urgency` (high→normal→low→null via `CASE`) then `sla_deadline ASC NULLS LAST`.
- **`ContactsRepository.ts` (modify):** add `getById(id)`, `list({ category?, limit, offset })`, `patch(id, { category?, notes?, styleNotes?, doNotAutoDraft? })` (only provided fields; `style_notes` stored as JSON).

### Sync integration — `apps/service/server/sync/SyncManager.ts` (modify)

- Constructor gains two collaborators (kept behind tiny interfaces so tests pass fakes): `classificationQueue: { enqueue(messageId: string): void }` and `stateMachine: { onOutbound(threadId: string): void }`, plus the `SettingsRepository` (to read `agent.classify_on_inbound`). Existing `(db, registry, eventBus, now)` args are preserved; the new ones are appended (existing tests updated to pass fakes).
- `persistBatch` change: **sort the batch chronologically** by `dateReceived ?? dateSent ?? 0` before persisting (so older messages persist first and `last_*_at` settle correctly), and collect the set of **touched thread ids**.
- After the batch commits, **post-batch routing** runs once per touched thread (outside the per-message transaction):
  - Determine the thread's latest message (`MessagesRepository.listByThread(threadId)` last element, or `MAX(COALESCE(date_received,date_sent,0))`).
  - If latest is **outbound** → `stateMachine.onOutbound(threadId)`.
  - If latest is **inbound** → if `settings.get('agent.classify_on_inbound') !== false` → `classificationQueue.enqueue(latestInbound.id)`; else leave thread `needs_classification`.
- `persist` now returns the inserted message id (or null if it was a duplicate/no-op) so post-batch routing can find the latest reliably; existing `changed`/emit behavior unchanged.

### API — `apps/service/server/api/`

All under `/api/v1`, behind the bearer guard, `{data}`/`{error}` envelopes.

- **`threads.ts` (extend):**
  - `GET /threads/needs-attention` → `ThreadsRepository.needsAttention()` mapped to `NeedsAttentionItem[]` (joins pending-follow-up flag). Sorted server-side per §9.
  - `POST /threads/:id/state` — body `{ state, reason? }` (zod-validated against `ThreadState`); `StateMachine.onManual(id, state, reason)`; 404 if thread missing; returns the updated `ThreadSummary`.
  - `POST /threads/:id/classify` — find the thread's latest inbound (`MessagesRepository.latestInboundForThread`); 404 if the thread is missing; if it exists but has no inbound message → throw the existing `ValidationError('No inbound message to classify')` (400 `validation_error`); else `classificationQueue.enqueue(msg.id)`; return `{ data: { queued: true } }`. (SSE `thread:updated` delivers the result.)
- **`contacts.ts` (new):**
  - `GET /contacts?category=&limit=&offset=` → `ContactView[]`.
  - `GET /contacts/:id` → `ContactView` (404 if missing).
  - `PATCH /contacts/:id` — body `{ category?, notes?, styleNotes?, doNotAutoDraft? }` (zod; `category` against `ContactCategory`); `ContactsRepository.patch`; `action_log.append({actor:'user', action:'contact_updated', targetType:'contact', targetId:id, details:{fields}})`; returns updated `ContactView`. Category change affects **future** SLA computation only (no retroactive recompute).

### Server wiring — `server.ts` + `index.ts`

- `ServerDeps` gains `classificationQueue` and `contactsRepo`/`stateMachine` only as needed by the routes (threads route needs `classificationQueue` + `stateMachine`; contacts route needs the DB). Keep it minimal: pass `classificationQueue` and `stateMachine` into `ServerDeps`; routes construct their own repositories from `db` (matching the current `registerThreadsRoutes(app, { db })` pattern).
- `index.ts` composition root:
  - Build `SettingsRepository`, `ContactsRepository`, `MessagesRepository`, `ThreadsRepository`, `ActionLogRepository`, `FollowUpsRepository`.
  - Build the **`GatewayClient` if configured**: read gateway URL (`settings.get('llm.gateway_url')`), API key + payload key + CF creds from `KeychainStore` (reuse the `evaluateFirstRun` inputs). If all present → `createGatewayClient(...)`; else `null` (classification disabled, logged).
  - Build `StateMachine`, `PromptAssembler`, `Classifier`, `ClassificationQueue`, inject `classificationQueue` + `stateMachine` into `SyncManager`.
  - Build `FollowUpEngine` and `start()` it (5-min interval, `unref`).
  - **Startup recovery:** after server listen + account resume, `ThreadsRepository.findNeedsClassification()` → for each, `MessagesRepository.latestInboundForThread(id)` → `classificationQueue.enqueue(msg.id)`.
  - Graceful shutdown also `followUpEngine.stop()`.

## Data flow (new inbound message, live)

IMAP IDLE → `SyncManager.syncIncremental` → persist messages (unchanged) → post-batch: thread's latest message is inbound → `classificationQueue.enqueue(msgId)` → drain → `Classifier.classify`: `PromptAssembler.buildClassificationPrompt` → `GatewayClient.complete(format:'json')` → `parseClassification` (retry once) → `StateMachine.onInboundClassified` → `ThreadsRepository.applyClassification` (state/urgency/summary/sla) → `action_log` → `eventBus.emit('thread:updated')`. Within ≤5 min the `FollowUpEngine` flags any breach.

For an **outbound** latest message (she replied, or Sent re-synced): post-batch → `StateMachine.onOutbound` → `awaiting_their_reply` + 72h SLA, synchronously, no LLM.

## Error handling

- **Gateway not configured** (missing creds) → `GatewayClient` is `null`; `Classifier` skips and leaves `needs_classification` (logged once per call, metadata only). The service still runs and syncs.
- **Classification parse failure** → one stricter retry; second failure → `classification_failed` action-log, thread stays `needs_classification`, SSE emitted so the UI can offer manual classify.
- **Gateway transport/`SecretaryError`** → caught in `Classifier.classify` (never throws into the queue), treated like a parse failure.
- **Queue isolation** → `classify` is self-contained and never rejects, so one bad job can't stall the drain loop; the loop continues to the next id.
- **Follow-up engine** → `runOnce` wrapped so a DB hiccup logs + continues at the next tick.
- All new thrown API errors reuse existing `SecretaryError` subclasses — `NotFoundError` (404) and `ValidationError` (400, code `validation_error`) from `shared-types/errors.ts`; **no new error class is needed**. Surfaced via the current error handler. No new logging of bodies/prompts (§5).

## Testing strategy

Vitest, 60% app coverage target. Fake `GatewayClient`; real migrated temp DB (close-before-cleanup, Windows pattern).

- **Pure `StateMachine`:** table-driven over every `(prev, requires_response)` and outbound; SLA computation for each state × category × missing-key fallback, anchored to message timestamps.
- **`classificationSchema`:** `parseClassification` for clean JSON, fenced JSON, stringy booleans, over-long summary (clamped), garbage (→ null).
- **`PromptAssembler`:** assembles expected system + context (contact truncation 500, ≤3 prior messages @200, body truncation 2000) against the temp DB; missing message → throws.
- **`Classifier`** (fake gateway): success → correct `applyClassification` write + `classified` action-log + SSE; first-attempt garbage then valid → succeeds via retry; two failures → `classification_failed` + thread stays `needs_classification`; gateway `null` → skip; gateway throws → handled like failure.
- **`ClassificationQueue`:** sequential drain (assert order, concurrency 1 via an instrumented fake classifier), dedup of an already-queued id, `onIdle` resolves.
- **`FollowUpEngine.runOnce`:** creates one `follow_ups` row per breaching thread, skips threads with an existing pending follow-up, ignores non-breaching/`null`-SLA threads, emits SSE, returns count.
- **Repositories:** `FollowUpsRepository` (insert/hasPending/listPending/dismiss/resolve), `ThreadsRepository` new queries (needsAttention ordering, findSlaBreaches, findNeedsClassification, applyClassification/setState), `ContactsRepository` (getById/list/patch), `MessagesRepository` (insert returns id, getById, latestInboundForThread).
- **`SyncManager` integration** (fake provider + fake queue + fake state machine): a batch where a thread's latest message is inbound → `enqueue` called with that id; latest outbound → `onOutbound` called; `classify_on_inbound=false` → neither; chronological sort verified.
- **API** (`app.inject`, fake queue/state machine): `GET /needs-attention` (ordering high→low urgency, SLA asc, includes follow-up threads); `POST /threads/:id/state` (valid transition, bad state 400, 404); `POST /threads/:id/classify` (enqueues, no-inbound 400); contacts `GET`/`GET :id`/`PATCH` (category change persisted + action-logged).
- **Manual interop:** documented runbook (`docs/PHASE-4-MANUAL-VERIFICATION.md`) — configure the gateway creds + `llm.gateway_url` pointing at the operator Ollama (`qwen2.5:1.5b` for the pipeline), resync the Gmail account, watch threads classify, hit `GET /needs-attention`, confirm urgency/SLA ordering and that overdue threads produce follow-ups within 5 minutes; manual `POST /threads/:id/classify` and a `PATCH /contacts/:id` category change.

## Acceptance criteria (BRIEF §14 Phase 4) → how met

| Criterion                                                                     | Met by                                                                                                         |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Inbound messages get classified within seconds of sync                        | `SyncManager` post-batch enqueue → `ClassificationQueue` → `Classifier`; manual run + `Classifier`/queue tests |
| Threads requiring response surface in Needs Attention sorted by urgency + SLA | `GET /threads/needs-attention` + `ThreadsRepository.needsAttention` ordering; route test                       |
| SLA breaches generate `follow_ups` within 5 minutes of the deadline           | `FollowUpEngine` 5-min cron + `runOnce`; engine test + manual                                                  |
| Action log captures every classification                                      | `Classifier` `classified` / `classification_failed` appends; tests                                             |
| Manual category override updates future SLAs                                  | `PATCH /contacts/:id` → category drives `StateMachine.computeSlaDeadline` on next transition; tests            |

## Risks & mitigations

- **Small-model JSON reliability** (`qwen2.5:1.5b`) — `format:'json'` + strict prompt + zod validation + one stricter retry + graceful `needs_classification` fallback; classification _quality_ is a model concern, not a pipeline concern (improves with a bigger model).
- **Backlog classification cost / follow-up flood on first sync** — sequential queue throttles LLM load; per-thread (not per-message) cuts call count; overdue follow-ups are correct and harmless pre-Push. Optional later: suppress `sla_breach` for very old threads.
- **Native-module ABI** — tests/`dev:server` require the Node ABI build (unchanged Phase 3 gotcha).
- **Gateway-down resilience** — `null`/throwing gateway never crashes sync; threads simply stay `needs_classification` and can be re-classified later.
- **Ordering on bulk import** — chronological sort + per-thread-latest determination make final state independent of provider fetch order.
