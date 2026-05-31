# Phase 3 — Proton via Bridge / Generic IMAP Provider — Design

**Date:** 2026-05-30
**Status:** Approved (pending spec review)
**Brief reference:** `BRIEF.md` §7 (provider interface), §6 (schema), §9 (API), §11 (sync behavior), §14 Phase 3.

## Context

Phase 2 (service skeleton) is complete and merged: `apps/service` has the encrypted SQLCipher DB with the full §6 schema, the Fastify server (`buildServer` + auth guard + `{error}` envelope), `SettingsRepository` + `PushSubscriptionRepository`, `KeychainStore`, `GatewayClient`, and the accounts/messages/threads/contacts tables already created by migration `0001_init.sql` (no repositories for them yet).

Phase 3 adds the first **email provider**: a generic IMAP client used for **Proton via Bridge and any other IMAP server**. Proton Mail Bridge is just a local proxy exposing standard IMAP (`127.0.0.1:1143`) + SMTP (`127.0.0.1:1025`), so the provider is not Proton-specific — it talks plain IMAP/SMTP. The same code serves Gmail-over-IMAP (`imap.gmail.com:993` + app password), which is how we verify it **now**; Proton Bridge is verified once the principal's paid account exists.

The real PWA screens remain Phase 2.5, so Phase 3 is driven and tested through the **accounts/threads HTTP API** (curl-able) rather than UI.

### Resolved design decisions

- **Generic IMAP, not Proton-specific.** Account config (host/port/TLS/credentials) is the only thing that differs between Gmail and Proton Bridge.
- **No Docker for tests.** Pure logic (threading, normalization, sync diffing) is unit-tested with email fixtures; repositories against the temp encrypted DB; provider orchestration + API via a **mocked `imapflow`/fake provider**. Real IMAP/SMTP interop is covered by manual Gmail (now) and Proton Bridge (later) runs — mirroring how Phase 2 tested the gateway via a fake gateway.
- **Manual testing via API.** No PWA screens this phase; `POST /accounts/imap`, `GET /threads`, and a minimal send endpoint make the full flow exercisable with curl.
- **New dependencies** (all pure-JS, no native builds, same maintainer as `imapflow`): `imapflow` (IMAP), `nodemailer` (SMTP send), `mailparser` (raw RFC822 → text/html/headers/attachments).

## Goals (this phase)

1. `EmailProvider` interface (brief §7) + an `ImapProvider` implementing it over IMAP/SMTP.
2. Add an IMAP account via API: test the connection, store the password in the keychain, persist the account, and start syncing.
3. Initial sync: last 90 days of INBOX + Sent, deduped by Message-ID, persisted as messages/threads/contacts with threading reconstructed.
4. Live new-mail watching via IMAP IDLE, with reconnect/backoff; new mail appears within ~15s.
5. Send a manually-composed reply via SMTP (threading headers set).
6. Read API: list threads, view a thread with its messages.
7. Action-log entry for every persisted message.

## Non-goals (deferred)

- Classification, state machine, SLA, needs-attention, follow-ups (Phase 4).
- Agent drafting + the drafts table workflow (Phase 5) — Phase 3's send is a minimal manual compose that Phase 5 builds on.
- The real PWA inbox/thread screens (Phase 2.5).
- Gmail-API and Graph providers (Phases 7/8). Gmail is used here only as a _generic IMAP_ target for testing.
- Flag/state write-back beyond `markRead`; attachment body storage (brief §15).

## Architecture

### New shared types — `packages/shared-types/src/domain.ts`

Shared by the server and the future PWA. Exports:

- Enums/unions: `Provider` (`'imap'|'gmail'|'graph'`), `MessageDirection` (`'inbound'|'outbound'`), `ThreadState`, `ContactCategory`, `Urgency` (mirroring the §6 CHECK constraints).
- `RawMessage` — normalized provider-agnostic message DTO (brief §7):
  - `providerId`, `messageIdHeader?`, `inReplyTo?`, `references: string[]`, `from: { address: string; name?: string }`, `to/cc/bcc: Address[]`, `subject?`, `bodyText?`, `bodyHtml?`, `snippet?`, `direction`, `dateSent?`, `dateReceived?`, `isRead`, `isStarred`, `folder`, `labels: string[]`, `attachmentsMeta: AttachmentMeta[]`, `rawSizeBytes?`.
- `SendInput` — `{ to, cc?, bcc?, subject?, bodyText, bodyHtml?, inReplyToMessageId? }`.
- Domain view types for the API: `ThreadSummary`, `ThreadWithMessages`, `MessageView`, `AccountView` (what the threads/accounts endpoints return; ISO-8601 date strings per §16).

Index re-exports `domain.js` alongside `errors.js`.

### Provider layer — `apps/service/server/providers/`

- `ProviderInterface.ts` — the `EmailProvider` interface verbatim from brief §7 (`accountId`, `connect`/`disconnect`/`isConnected`, `syncIncremental`, `syncFull`, `startWatching`/`stopWatching`, `sendMessage`, `markRead`, optional `moveToFolder`, `healthCheck`). Imports `RawMessage`/`SendInput` from shared-types. `syncIncremental` returns `{ newMessages, updatedMessages, nextSyncState }`.
- `ImapConfig` — resolved connection config: `{ accountId, imap: { host, port, secure, requireTLS, rejectUnauthorized }, smtp: { host, port, secure }, auth: { user, pass } }`.
- `ImapProvider.ts` — implements `EmailProvider`:
  - IMAP via `imapflow` `ImapFlow`. Gmail → `secure:true` (993); Proton Bridge → `secure:false` + STARTTLS, and `rejectUnauthorized:false` for loopback hosts (Bridge's self-signed cert). Loopback detection: host in `{127.0.0.1, ::1, localhost}`.
  - `syncFull(sinceMs)` — open INBOX then Sent; `search({ since })`; fetch `{ uid, flags, envelope, internalDate, size, source }`; parse `source` with `mailparser.simpleParser` → `RawMessage` (direction from folder: Sent→outbound else inbound). Dedup by Message-ID across folders.
  - `syncIncremental()` — per-folder sync state `{ uidValidity, lastUid }`; fetch `uid > lastUid`. `updatedMessages` populated from CONDSTORE/`modseq` flag changes when the server advertises it, else `[]` (flag drift reconciled on `resync`). Returns `nextSyncState`.
  - `startWatching(onChange)` — `imapflow` auto-IDLEs; subscribe to its `'exists'` event → debounce → `onChange()`. Reconnect on `'close'`/`'error'` with capped exponential backoff.
  - `sendMessage(input)` — `nodemailer` SMTP transport built from the SMTP config; sets `In-Reply-To`/`References` from `inReplyToMessageId`; appends the sent copy is left to the server (Sent folder will re-sync). Returns `{ providerMessageId }` (the Message-ID).
  - `markRead`, `healthCheck` (connect + NOOP), `disconnect`.
- `ProviderRegistry.ts` — owns the live `EmailProvider` per `accountId` (create/get/dispose); the SyncManager and routes go through it.

### Sync — `apps/service/server/sync/`

- `threading.ts` — **pure**. `resolveThread(raw, lookups)` → `{ threadId }` (existing) or a new-thread descriptor. Order: (1) `inReplyTo`/`references` match an existing `message_id_header`; (2) fallback to `subject_normalized` (Re:/Fwd: stripped, lowercased) + participant overlap within a recency window. Also `normalizeSubject(subject)`.
- `normalize.ts` — **pure**. `toMessageRow(raw, accountId, threadId)`, `toContactUpserts(raw)`, `toThreadUpsert(...)` — map `RawMessage` → DB row shapes (JSON-encoding array columns; computing `snippet`).
- `SyncManager.ts` — orchestrates per account: first run → `syncFull`, else `syncIncremental`; persists each message in a transaction via the repositories (upsert contact, resolve+upsert thread, insert message, write `action_log`); updates the account's `sync_state` + `last_synced_at`; then `startWatching`. On watcher `onChange` → `syncIncremental` → persist. Emits `eventBus` `thread:updated` (consumed by SSE; no classification yet).
- `ImapWatcher.ts` — thin wrapper binding a provider's watch callback to the SyncManager (kept separate so Gmail/Graph watchers slot in later).

### DB — just-in-time repositories (`apps/service/server/db/repositories/`)

- `MessagesRepository` — insert (idempotent on `(account_id, provider_id)`), get by id, list by thread, exists-by-message-id (for dedup/threading).
- `ThreadsRepository` — upsert/find for threading (by `provider_thread_id` / `subject_normalized`), update aggregates (`message_count`, `last_*_at`, `participants`), list (paginated/filtered), get with messages.
- `ContactsRepository` — upsert by `email_address` (COLLATE NOCASE), bump counts/last_seen.
- `ActionLogRepository` — append (`actor`, `action`, `target_type`, `target_id`, `details` — never message bodies).
- `schema.ts` gains the `MessageRow`, `ThreadRow`, `ContactRow`, `ActionLogRow` types (the deferred ones from Phase 2).

### API — `apps/service/server/api/`

All under `/api/v1`, behind the bearer guard, `{data}`/`{error}` envelopes.

- `accounts.ts`:
  - `POST /accounts/imap` — body `{ displayName, emailAddress, imapHost, imapPort, useTls, smtpHost, smtpPort, password }`. Validate (zod) → build `ImapConfig` → `healthCheck` (fail ⇒ `400 imap_connection_failed`, nothing persisted) → store password in keychain (`imap.<accountId>`) → insert `accounts` row → kick off initial sync in the background via SyncManager → return the `AccountView` (`syncState: 'syncing'`).
  - `GET /accounts` — list `AccountView` (connection + sync status).
  - `DELETE /accounts/:id` — stop watcher, delete account (cascade removes messages/threads via FK), delete keychain password.
  - `POST /accounts/:id/resync` — trigger a full resync.
- `threads.ts`:
  - `GET /threads` — paginated, optional `?accountId=`; sorted by `last_message_at DESC`. (state/category filters land with Phase 4.)
  - `GET /threads/:id` — `ThreadWithMessages` (messages oldest→newest).
- `messages.ts` (minimal send for this phase):
  - `POST /accounts/:id/send` — body `{ to, cc?, subject?, bodyText, bodyHtml?, inReplyToMessageId? }` → `provider.sendMessage` → `{ data: { providerMessageId } }`. Phase 5's drafts workflow supersedes this.

### Server wiring

`ServerDeps` gains `providers: ProviderRegistry` and `sync: SyncManager` (constructed in `index.ts` from `db` + `KeychainStore` + `eventBus`). On startup, `index.ts` loads enabled accounts and starts the SyncManager for each (resumes watching). Routes registered in `buildServer`'s `/api/v1` block alongside the existing ones.

## Data flow (new inbound message)

IMAP IDLE `exists` → `SyncManager.syncIncremental(account)` → provider fetches UIDs > lastUid → `mailparser` → `RawMessage[]` → per message (transaction): `ContactsRepository.upsert` → `threading.resolveThread` → `ThreadsRepository.upsert` + aggregate update → `MessagesRepository.insert` → `ActionLogRepository.append` → account `sync_state` updated → `eventBus.emit('thread:updated')`.

## Error handling

- Connection failures on add-account → typed `400 imap_connection_failed` (nothing persisted, no keychain write).
- Watcher disconnects → reconnect with capped exponential backoff; logged (metadata only).
- Parse failures on a single message → log + skip that message, don't abort the batch.
- All thrown errors are `SecretaryError` subclasses — add `ImapError` to `shared-types/errors.ts` with code `imap_connection_failed` (status 400); surfaced via the existing error handler.

## Testing strategy

Vitest, 60% coverage target. No Docker.

- **Pure logic (fixtures):** `threading.resolveThread` (reply-chain match, subject fallback, new thread), `normalizeSubject`, `normalize.*` (RFC822 fixture → expected rows), Message-ID dedup.
- **Repositories:** `Messages`/`Threads`/`Contacts`/`ActionLog` against the temp encrypted DB (close-before-cleanup per the Windows pattern), including idempotent insert and thread-aggregate updates.
- **Provider orchestration:** a `FakeEmailProvider` (implements `EmailProvider`, returns scripted `RawMessage[]`) drives `SyncManager` → asserts persisted rows, thread reconstruction, action-log entries, `nextSyncState`. The real `ImapProvider`'s imapflow/nodemailer wiring is **manually verified** (not unit-tested), like `KeychainStore`.
- **API:** Fastify `inject` with a `ProviderRegistry` backed by the fake provider — add-account (success + connection-fail 400 + unauth 401), list/get threads, send (calls provider.sendMessage), delete.
- **Manual interop:** documented runbook — add a Gmail account (app password) via curl, watch sync, read threads, send a reply; then the same against Proton Bridge.

## Acceptance criteria (BRIEF §14 Phase 3) → how met

| Criterion                                                            | Met by                                                                   |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Adding the IMAP account syncs last 90 days, shows in the (API) inbox | `POST /accounts/imap` + `syncFull` + `GET /threads`; manual Gmail/Proton |
| Sending a manually-composed reply sends via the provider             | `POST /accounts/:id/send` → `nodemailer`; manual                         |
| New mail appears within ~15s                                         | IMAP IDLE watcher → `syncIncremental`; manual                            |
| Threading/contacts/action-log correct                                | pure-logic + repository tests; fake-provider SyncManager test            |

## Risks & mitigations

- **imapflow/mailparser ESM interop** under NodeNext — verify import shape first (they're CJS-with-types; use default/named per their typings).
- **Gmail app password / IMAP enablement** — documented as a manual-test prerequisite; not a code concern.
- **Proton Bridge self-signed cert** — `rejectUnauthorized:false` for loopback hosts; documented.
- **Large mailbox initial sync** — 90-day window bounds it; sync runs in the background so the add-account request returns promptly; batch fetches.
- **Flag/update tracking** — `updatedMessages` is best-effort (CONDSTORE when available); full reconciliation via `resync`. Acceptable for v1.
