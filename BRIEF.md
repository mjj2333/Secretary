# Secretary — Project Brief

A locally-run AI email assistant. The user (operator) runs an LLM on their own GPU machine. A second user (the principal) runs a tray service on her desktop that monitors her inboxes, drafts replies using the operator's LLM, and surfaces a mobile-first PWA she uses primarily from her phone.

This brief is the authoritative source of truth. When implementation choices conflict with it, update the brief first, then implement.

---

## 1. Glossary

- **Operator** — the person running the LLM and gateway (their Windows desktop with GPU).
- **Principal** — the person whose email the agent manages. Runs the tray service on her desktop. Uses the PWA primarily from her phone.
- **Gateway** — HTTP service on the operator's machine. Auths requests, decrypts payloads, forwards to Ollama, encrypts response, returns.
- **Service** — the tray app on the principal's desktop. Does all email work and serves the PWA.
- **PWA** — the web UI served by the service, used primarily on the principal's phone.
- **Bridge** — Proton Mail Bridge, installed separately on the principal's desktop.
- **Provider** — an email backend abstraction (Graph, Gmail, IMAP).

---

## 2. End state

### On the operator's Windows desktop

- Ollama running as a service, auto-starts on boot
- Gateway service running, exposed at `https://llm.<operator-domain>` via Cloudflare Tunnel
- Cloudflare Access policy in front of the gateway requiring a Service Token
- Gateway validates an additional API key and decrypts AES-256-GCM payloads

### On the principal's desktop (Mac or Windows)

- Proton Mail Bridge installed and running (official Proton installer; not managed by us)
- Secretary tray service installed, auto-starts on login
- Tray icon with status and a small menu (no desktop window)
- HTTPS server on a local port (mkcert-signed certificate)
- PWA served from that local URL
- Cloudflare Tunnel from her machine exposes the PWA at `https://secretary.<her-domain>` for phone access. (Alternative: Tailscale; see §10.)

### On the principal's phone

- PWA installed to home screen
- Web Push notifications enabled
- Phone is the primary interface; desktop browser is fallback

### Data flow

- Email content lives only on her desktop's encrypted SQLite database
- LLM prompts cross the operator boundary, encrypted end-to-end at the application layer
- The operator never persists prompt or response content

---

## 3. Stack (locked unless changed in this brief)

### Repository

- Monorepo, pnpm workspaces, TypeScript throughout
- Node 20 LTS minimum
- ESM modules

### Gateway (operator)

- Node + TypeScript
- HTTP framework: Fastify
- Ollama client: native `fetch` to `http://localhost:11434`
- Runs as Windows service via NSSM
- Cloudflare Tunnel via `cloudflared` (already configured on operator machine for other services)

### Service (principal)

- Node + TypeScript
- Electron used only as packaging shell and for tray icon (no `BrowserWindow` opened)
- HTTP framework: Fastify, served over HTTPS using mkcert-generated certs
- SQLite: `better-sqlite3-multiple-ciphers` (SQLCipher-compatible)
- Email libraries:
  - `imapflow` for IMAP (used for Proton via Bridge, and any generic IMAP)
  - `googleapis` for Gmail
  - `@microsoft/microsoft-graph-client` for Outlook/Hotmail
- OAuth helpers:
  - `@azure/msal-node` for Microsoft
  - `google-auth-library` for Google
- Keychain: `@napi-rs/keyring`
- Web Push: `web-push` library, VAPID keys generated on first run
- Logging: `pino` with rotating file transport, never logs message bodies or prompts

### PWA

- React 18 + TypeScript + Vite
- Tailwind CSS (mobile-first utility classes only)
- TanStack Query for server state
- Wouter or React Router for routing
- Workbox-generated service worker for offline caching
- Web Push API client

### Distribution

- `electron-builder` produces:
  - macOS: universal `.dmg` (Intel + ARM)
  - Windows: NSIS `.exe`
- Auto-update via `electron-updater` pointing to a GitHub Releases channel (private repo with PAT)
- No code signing in v1 (right-click → Open on Mac; SmartScreen click-through on Windows). Note this prominently in install instructions.

---

## 4. Repository layout

```
secretary/
├── BRIEF.md                          # This document. Read before starting any session.
├── README.md                         # Setup and dev instructions
├── package.json                      # Workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .editorconfig
├── .gitignore
├── apps/
│   ├── gateway/                      # Operator's LLM gateway
│   │   ├── src/
│   │   │   ├── server.ts             # Fastify server + routes
│   │   │   ├── ollama.ts             # Ollama client
│   │   │   ├── auth.ts               # API key validation
│   │   │   ├── ratelimit.ts          # Token bucket
│   │   │   └── index.ts              # Entrypoint
│   │   ├── test/
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── service/                      # Principal's tray service + PWA
│       ├── electron/                 # Electron shell (tray only, no window)
│       │   ├── main.ts               # Tray icon, lifecycle, auto-update
│       │   └── tray-menu.ts
│       ├── server/                   # Node service (where the work happens)
│       │   ├── server.ts             # Fastify HTTPS server
│       │   ├── api/                  # REST endpoints called by the PWA
│       │   │   ├── auth.ts           # PWA session token
│       │   │   ├── accounts.ts
│       │   │   ├── threads.ts
│       │   │   ├── drafts.ts
│       │   │   ├── contacts.ts
│       │   │   ├── followups.ts
│       │   │   ├── settings.ts
│       │   │   └── push.ts
│       │   ├── providers/            # Email provider abstraction
│       │   │   ├── ProviderInterface.ts
│       │   │   ├── ImapProvider.ts   # Proton via Bridge + generic IMAP
│       │   │   ├── GmailProvider.ts
│       │   │   ├── GraphProvider.ts
│       │   │   └── ProviderRegistry.ts
│       │   ├── agent/
│       │   │   ├── Classifier.ts
│       │   │   ├── Drafter.ts
│       │   │   ├── FollowUpEngine.ts
│       │   │   ├── ContactProfiler.ts
│       │   │   └── PromptAssembler.ts
│       │   ├── llm/                  # Gateway client (encryption, auth headers)
│       │   │   └── GatewayClient.ts
│       │   ├── auth/                 # OAuth flows + keychain access
│       │   │   ├── KeychainStore.ts
│       │   │   ├── OAuthGoogle.ts
│       │   │   └── OAuthMicrosoft.ts
│       │   ├── db/
│       │   │   ├── connection.ts     # SQLCipher open + migrations runner
│       │   │   ├── migrations/       # Numbered .sql files
│       │   │   ├── repositories/     # One per table, typed queries
│       │   │   └── schema.ts         # TypeScript types matching DB rows
│       │   ├── sync/
│       │   │   ├── SyncManager.ts    # Coordinates all providers
│       │   │   ├── ImapWatcher.ts    # IDLE-based
│       │   │   ├── GmailWatcher.ts   # History API polling
│       │   │   └── GraphWatcher.ts   # Delta query polling
│       │   ├── notifications/
│       │   │   ├── WebPushSender.ts
│       │   │   └── SubscriptionStore.ts
│       │   ├── crypto/
│       │   │   ├── PayloadCrypto.ts  # AES-256-GCM wrap/unwrap
│       │   │   └── SessionTokens.ts
│       │   ├── prompts/              # System prompts as versioned .md files
│       │   │   ├── classifier.md
│       │   │   ├── drafter.md
│       │   │   └── voice-baseline.md
│       │   └── index.ts              # Service entrypoint
│       ├── pwa/                      # The PWA, served by the server
│       │   ├── index.html
│       │   ├── manifest.webmanifest
│       │   ├── src/
│       │   │   ├── main.tsx
│       │   │   ├── App.tsx
│       │   │   ├── routes/
│       │   │   │   ├── NeedsAttention.tsx   # Default route
│       │   │   │   ├── ThreadView.tsx
│       │   │   │   ├── Inbox.tsx            # Optional full list
│       │   │   │   ├── Contacts.tsx
│       │   │   │   ├── Settings.tsx
│       │   │   │   └── FollowUps.tsx
│       │   │   ├── components/
│       │   │   ├── api/                     # TanStack Query hooks
│       │   │   ├── push/                    # Service worker registration
│       │   │   └── styles/
│       │   ├── vite.config.ts
│       │   └── tsconfig.json
│       └── package.json
├── packages/
│   ├── shared-types/                 # Shared TS types (DTOs, enums)
│   │   ├── src/
│   │   │   ├── api.ts                # API request/response shapes
│   │   │   ├── domain.ts             # Domain types (Thread, Message, etc.)
│   │   │   └── index.ts
│   │   └── package.json
│   ├── shared-crypto/                # Payload encryption used by gateway + service
│   │   ├── src/
│   │   │   ├── aesgcm.ts
│   │   │   └── index.ts
│   │   └── package.json
│   └── llm-protocol/                 # Request/response envelope schemas
│       ├── src/
│       │   └── index.ts
│       └── package.json
├── infra/
│   ├── cloudflared/
│   │   ├── operator-tunnel.example.yml
│   │   └── principal-tunnel.example.yml
│   ├── nssm/
│   │   └── install-gateway.ps1
│   └── mkcert/
│       └── README.md
└── docs/
    ├── ARCHITECTURE.md               # Diagrams, data flow
    ├── ONBOARDING-OPERATOR.md
    ├── ONBOARDING-PRINCIPAL.md
    ├── PROMPTS.md                    # How prompts are assembled, where to edit
    └── THREAT-MODEL.md
```

---

## 5. Security model

### Secrets inventory

| Secret                                        | Generated by           | Stored on operator | Stored on principal         |
| --------------------------------------------- | ---------------------- | ------------------ | --------------------------- |
| Cloudflare Service Token (client ID + secret) | Cloudflare dashboard   | Password manager   | Keychain                    |
| Gateway API key                               | `openssl rand -hex 32` | Env var            | Keychain                    |
| Payload encryption key                        | `openssl rand -hex 32` | Env var            | Keychain                    |
| Service auth tokens for PWA                   | Service on startup     | —                  | Keychain + PWA localStorage |
| VAPID keys (push)                             | Service on first run   | —                  | Keychain                    |
| SQLite DB encryption key                      | Service on first run   | —                  | Keychain                    |
| Provider OAuth refresh tokens                 | Per-provider OAuth     | —                  | Keychain                    |
| Bridge IMAP password                          | Bridge UI              | —                  | Keychain                    |

Anything ending in "Keychain" on the principal's side uses `@napi-rs/keyring` and is keyed by a service name like `secretary.<accountId>.<purpose>`.

### Encryption layers (operator-bound traffic)

1. TLS to Cloudflare edge (Cloudflare-managed cert)
2. Cloudflare Access validates Service Token at edge
3. Cloudflare to operator's gateway: tunneled (Full Strict mode)
4. Gateway validates `X-API-Key` header against env var
5. Gateway decrypts AES-256-GCM body using shared key
6. After Ollama returns, gateway encrypts response symmetrically

If Cloudflare is ever in plaintext view, the body is opaque ciphertext. Three independent secrets must all be compromised to break the channel.

### Encryption layers (PWA-to-service traffic)

1. mkcert-signed HTTPS (locally trusted on her devices only)
2. Service auth token in `Authorization: Bearer` header, validated on every request
3. Service rejects any origin other than the served PWA URL (strict CORS, no wildcards)

### At rest (principal's machine)

- SQLite encrypted with SQLCipher. Key in keychain.
- No secrets in env files or config files. All in keychain.
- Logs go to a rotated file in user-data directory. **Never include message bodies, prompts, or completions in logs.** Only metadata (ids, timestamps, durations, status codes).

### Threat model assumptions

- Operator's machine is trusted by the operator but does not see message contents in plaintext (only prompts that are AES-encrypted at the application layer).
- Principal's machine being lost/stolen: full-disk encryption + SQLCipher key requiring OS login = safe.
- Cloudflare being compromised: payload encryption means content stays opaque; routing could be redirected but Service Token + API key + payload key all required to actually get LLM access.
- Network attacker: TLS plus payload encryption plus auth headers makes traffic interception non-recoverable.

---

## 6. Database schema

All tables exist in a single SQLCipher-encrypted SQLite database in the principal's user-data directory: `<userData>/secretary.db`.

Migrations are sequential `.sql` files in `apps/service/server/db/migrations/`. The migration runner records applied versions in a `_migrations` table.

### `accounts`

- `id` TEXT PRIMARY KEY (uuid)
- `provider` TEXT NOT NULL CHECK (provider IN ('imap','gmail','graph'))
- `display_name` TEXT NOT NULL
- `email_address` TEXT NOT NULL
- `imap_host` TEXT — null unless provider='imap'
- `imap_port` INTEGER
- `imap_use_tls` INTEGER (boolean)
- `smtp_host` TEXT
- `smtp_port` INTEGER
- `oauth_keychain_handle` TEXT — null unless provider in ('gmail','graph')
- `imap_password_keychain_handle` TEXT — null unless provider='imap'
- `sync_state` TEXT — JSON, provider-specific (delta tokens, history IDs, last UIDs per folder)
- `is_enabled` INTEGER (boolean) DEFAULT 1
- `created_at` INTEGER (unix ms)
- `last_synced_at` INTEGER

### `messages`

- `id` TEXT PRIMARY KEY (uuid, internal)
- `account_id` TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE
- `provider_id` TEXT NOT NULL — provider's own ID
- `thread_id` TEXT NOT NULL REFERENCES threads(id)
- `message_id_header` TEXT — RFC 2822 Message-ID
- `in_reply_to` TEXT
- `references_header` TEXT — JSON array of Message-IDs
- `from_address` TEXT NOT NULL
- `from_name` TEXT
- `to_addresses` TEXT — JSON array
- `cc_addresses` TEXT — JSON array
- `bcc_addresses` TEXT — JSON array
- `subject` TEXT
- `body_text` TEXT
- `body_html` TEXT
- `snippet` TEXT — first 200 chars of body_text
- `direction` TEXT NOT NULL CHECK (direction IN ('inbound','outbound'))
- `date_sent` INTEGER
- `date_received` INTEGER
- `is_read` INTEGER (boolean)
- `is_starred` INTEGER (boolean)
- `is_draft` INTEGER (boolean) — provider draft flag, distinct from our drafts table
- `folder` TEXT
- `labels` TEXT — JSON array for Gmail; or single-element for IMAP folder name
- `attachments_meta` TEXT — JSON `[{filename,size,content_type,provider_id}]`
- `raw_size_bytes` INTEGER
- `synced_at` INTEGER
- UNIQUE (account_id, provider_id)
- INDEX (thread_id, date_received)
- INDEX (account_id, date_received DESC)
- INDEX (from_address)
- INDEX (message_id_header)

### `threads`

- `id` TEXT PRIMARY KEY
- `account_id` TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE
- `provider_thread_id` TEXT — Gmail conversation, Graph conversation, or synthetic
- `subject_normalized` TEXT — subject with Re:/Fwd: prefixes stripped, lowercased
- `participants` TEXT — JSON array of email addresses
- `message_count` INTEGER DEFAULT 0
- `first_message_at` INTEGER
- `last_message_at` INTEGER
- `last_inbound_at` INTEGER
- `last_outbound_at` INTEGER
- `state` TEXT NOT NULL DEFAULT 'needs_classification' CHECK (state IN ('needs_classification','awaiting_their_reply','awaiting_your_reply','closed','scheduled_followup','informational'))
- `state_changed_at` INTEGER
- `state_reason` TEXT
- `sla_deadline` INTEGER — unix ms; null when not applicable
- `urgency` TEXT CHECK (urgency IN ('low','normal','high'))
- `last_agent_summary` TEXT
- `is_archived` INTEGER (boolean) DEFAULT 0
- INDEX (state, sla_deadline)
- INDEX (last_inbound_at DESC)

### `contacts`

- `id` TEXT PRIMARY KEY
- `email_address` TEXT NOT NULL UNIQUE COLLATE NOCASE
- `display_name` TEXT
- `aliases` TEXT — JSON array of other email addresses
- `category` TEXT NOT NULL DEFAULT 'unknown' CHECK (category IN ('client_established','client_new','screening','personal','vendor','noise','unknown'))
- `notes` TEXT
- `first_contact_at` INTEGER
- `last_contact_at` INTEGER
- `total_messages_in` INTEGER DEFAULT 0
- `total_messages_out` INTEGER DEFAULT 0
- `style_notes` TEXT — JSON
- `do_not_auto_draft` INTEGER (boolean) DEFAULT 0
- `screening_status` TEXT CHECK (screening_status IN ('never_screened','screening_in_progress','cleared','rejected') OR screening_status IS NULL)
- `booking_history` TEXT — JSON array
- INDEX (category)
- INDEX (last_contact_at DESC)

### `drafts`

- `id` TEXT PRIMARY KEY
- `thread_id` TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE
- `account_id` TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE
- `version` INTEGER NOT NULL
- `in_reply_to_message_id` TEXT REFERENCES messages(id)
- `to_addresses` TEXT — JSON
- `cc_addresses` TEXT — JSON
- `subject` TEXT
- `body_text` TEXT NOT NULL
- `body_html` TEXT
- `raw_intent` TEXT — what she dictated/typed, if any
- `polish_diff` TEXT — JSON, line-level diff between raw_intent and body_text
- `system_prompt_used` TEXT — for debugging
- `model_used` TEXT
- `tokens_in` INTEGER
- `tokens_out` INTEGER
- `latency_ms` INTEGER
- `status` TEXT NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review','editing','sent','discarded','failed'))
- `created_at` INTEGER
- `sent_at` INTEGER
- `final_body_sent` TEXT
- INDEX (thread_id, version)
- INDEX (status, created_at)

### `follow_ups`

- `id` TEXT PRIMARY KEY
- `thread_id` TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE
- `trigger_at` INTEGER NOT NULL
- `reason` TEXT NOT NULL CHECK (reason IN ('sla_breach','scheduled_reminder','awaiting_response','manual_pin'))
- `description` TEXT
- `status` TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','surfaced','dismissed','resolved'))
- `created_at` INTEGER
- `surfaced_at` INTEGER
- `resolved_at` INTEGER
- INDEX (status, trigger_at)

### `action_log`

- `id` TEXT PRIMARY KEY
- `timestamp` INTEGER NOT NULL
- `actor` TEXT NOT NULL CHECK (actor IN ('agent','user','system'))
- `action` TEXT NOT NULL
- `target_type` TEXT
- `target_id` TEXT
- `details` TEXT — JSON, action-specific (never include message bodies)
- INDEX (timestamp DESC)
- INDEX (target_type, target_id)

### `settings`

- `key` TEXT PRIMARY KEY
- `value` TEXT — JSON
- `updated_at` INTEGER

Pre-populated keys (with defaults):

- `agent.classify_on_inbound` = `true`
- `agent.autodraft_on_inbound` = `true`
- `agent.poll_interval_seconds` = `60`
- `agent.sla.client_established.awaiting_your_reply_hours` = `12`
- `agent.sla.client_new.awaiting_your_reply_hours` = `4`
- `agent.sla.default.awaiting_their_reply_hours` = `72`
- `llm.model` = `qwen2.5:14b-instruct-q5_K_M`
- `llm.temperature.classify` = `0.1`
- `llm.temperature.draft` = `0.5`
- `llm.gateway_url` — set during onboarding
- `notifications.web_push_enabled` = `false` until subscription registered

### `push_subscriptions`

- `id` TEXT PRIMARY KEY
- `endpoint` TEXT NOT NULL UNIQUE
- `keys_p256dh` TEXT NOT NULL
- `keys_auth` TEXT NOT NULL
- `user_agent` TEXT
- `created_at` INTEGER
- `last_used_at` INTEGER

### `style_examples`

Used for few-shot retrieval at draft time. Optional in v1, populated by mining sent mail in Phase 6.

- `id` TEXT PRIMARY KEY
- `source_message_id` TEXT REFERENCES messages(id) ON DELETE SET NULL
- `contact_category` TEXT
- `context_summary` TEXT — what the inbound message was about
- `reply_text` TEXT
- `tags` TEXT — JSON array of categorical tags
- `embedding` BLOB — float32 vector, optional; populated if vector index is enabled
- INDEX (contact_category)

---

## 7. Provider interface

All providers implement this contract. The agent and sync layers depend only on this interface.

```typescript
interface EmailProvider {
  readonly accountId: string;

  // Initial connection / token refresh
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  // Sync — returns new/updated messages since last sync state
  syncIncremental(): Promise<{
    newMessages: RawMessage[];
    updatedMessages: RawMessage[];
    nextSyncState: object;
  }>;
  syncFull(sinceUnixMs: number): Promise<RawMessage[]>;

  // Watchers
  startWatching(onChange: () => void): Promise<void>;
  stopWatching(): Promise<void>;

  // Actions
  sendMessage(input: SendInput): Promise<{ providerMessageId: string }>;
  markRead(providerMessageId: string, isRead: boolean): Promise<void>;
  moveToFolder?(providerMessageId: string, folder: string): Promise<void>;

  // Health
  healthCheck(): Promise<{ ok: boolean; details?: string }>;
}
```

`RawMessage` is a normalized DTO (defined in `packages/shared-types/src/domain.ts`). Each provider is responsible for translating its native message representation to `RawMessage` so downstream code doesn't care which provider it came from.

`SendInput` includes `to`, `cc`, `bcc`, `subject`, `bodyText`, `bodyHtml`, `inReplyToMessageId` (for threading headers).

---

## 8. Gateway API

All endpoints require Cloudflare Access Service Token headers AND `X-API-Key` header. The `/health` endpoint requires neither.

### `POST /v1/complete`

Request body (when encrypted, i.e. `Content-Type: application/cf-encrypted+json`):

```json
{
  "ciphertext": "base64(...)",
  "nonce": "base64(12 bytes)"
}
```

Decrypted body:

```json
{
  "model": "qwen2.5:14b-instruct-q5_K_M",
  "system": "string",
  "prompt": "string",
  "temperature": 0.5,
  "max_tokens": 800,
  "format": "json" | undefined,
  "json_schema": object | undefined
}
```

Response (same envelope as request):

```json
{
  "response": "string",
  "model": "string",
  "tokens_in": 123,
  "tokens_out": 456,
  "duration_ms": 7890
}
```

### `GET /health`

No auth. Returns:

```json
{ "ok": true, "model_loaded": "qwen2.5:14b-instruct-q5_K_M" | null }
```

### Rate limiting

Token bucket per API key: 60 req/min, burst 10. Returns 429 with `Retry-After` header when exceeded.

### Logging

Each request logs: timestamp, API key hash (first 8 chars), endpoint, status, duration, tokens_in, tokens_out. **No prompt or response content.**

---

## 9. Service-to-PWA API

All endpoints require `Authorization: Bearer <session_token>` and strict CORS to the served origin. Mounted under `/api/v1`.

### Auth

- `POST /api/v1/auth/session` — exchanges a short-lived bootstrap token (written to a file readable only by her user on first run) for a long-lived session token. Returns `{ token, expiresAt }`.
- `DELETE /api/v1/auth/session` — revokes current token.

### Accounts

- `GET /api/v1/accounts` — list connected accounts with status.
- `POST /api/v1/accounts/imap` — body: `{ displayName, emailAddress, imapHost, imapPort, useTls, smtpHost, smtpPort, password }`. Creates account, tests connection, stores password in keychain.
- `POST /api/v1/accounts/gmail/oauth/start` — returns auth URL for OAuth loopback.
- `GET /api/v1/accounts/gmail/oauth/callback` — receives the OAuth code from the loopback redirect.
- `POST /api/v1/accounts/graph/oauth/start` — same pattern.
- `GET /api/v1/accounts/graph/oauth/callback` — same pattern.
- `DELETE /api/v1/accounts/:id` — removes account and all associated data.
- `POST /api/v1/accounts/:id/resync` — triggers a full sync.

### Threads

- `GET /api/v1/threads/needs-attention` — primary screen. Returns threads where state is `awaiting_your_reply` OR an active follow-up exists, sorted by `urgency DESC, sla_deadline ASC`.
- `GET /api/v1/threads` — paginated list, optional filters `?state=&accountId=&contactId=&category=`.
- `GET /api/v1/threads/:id` — thread with messages.
- `POST /api/v1/threads/:id/state` — body `{ state, reason? }`. Manual override.
- `POST /api/v1/threads/:id/classify` — re-runs the classifier.

### Drafts

- `GET /api/v1/drafts/:id`
- `POST /api/v1/drafts` — body `{ threadId, rawIntent?, regenerate? }`. Creates a new draft version. Returns the draft.
- `PATCH /api/v1/drafts/:id` — body `{ bodyText?, subject? }`. Edits without regenerating.
- `POST /api/v1/drafts/:id/send` — sends via the provider. Returns the sent message ID. Updates thread state.
- `DELETE /api/v1/drafts/:id` — discards.

### Contacts

- `GET /api/v1/contacts` — paginated, filterable by category.
- `GET /api/v1/contacts/:id`
- `PATCH /api/v1/contacts/:id` — body `{ category?, notes?, styleNotes?, doNotAutoDraft? }`.

### Follow-ups

- `GET /api/v1/followups?status=pending` — surfaced reminders.
- `POST /api/v1/followups/:id/dismiss`
- `POST /api/v1/followups/:id/resolve`
- `POST /api/v1/followups` — body `{ threadId, triggerAt, description }` for manual pins.

### Settings

- `GET /api/v1/settings` — all settings.
- `PATCH /api/v1/settings` — body is a partial object of keys to update.

### Push

- `POST /api/v1/push/subscribe` — body is a `PushSubscription`. Saves to `push_subscriptions`.
- `DELETE /api/v1/push/subscribe/:endpoint`
- `POST /api/v1/push/test` — sends a test notification to all subscriptions.

### Server-Sent Events

- `GET /api/v1/events` — SSE stream. Events: `thread:updated`, `draft:ready`, `account:status`, `sync:progress`. Used by the PWA to update reactively without polling.

---

## 10. Network topology

### Operator side (already mostly in place)

- `cloudflared` running on operator's Windows desktop
- Tunnel hostname `llm.<operator-domain>` → `http://localhost:<GATEWAY_PORT>`
- Cloudflare Access policy on that hostname requiring Service Token

### Principal side

**Required**: HTTPS on her desktop for PWA. Use mkcert during install:

1. Install script runs `mkcert -install` (adds local CA to her OS trust store)
2. Generates cert for `localhost` and `127.0.0.1`
3. Service uses this cert for the local Fastify HTTPS server

**For phone access** — two options, document both in `docs/ONBOARDING-PRINCIPAL.md`:

Option A (recommended for v1): **Tailscale**

- She installs Tailscale on her desktop and phone, signs into both
- Her desktop's tailnet IP is known (e.g., `100.x.y.z`)
- Service binds to all interfaces with the mkcert cert valid for `<tailscale-hostname>`
- Phone PWA loaded from `https://<tailscale-hostname>:<PORT>`
- No third party in the data path

Option B: **Cloudflare Tunnel on her machine**

- She runs `cloudflared` on her desktop with her own Cloudflare account
- Tunnel hostname `secretary.<her-domain>` → `https://localhost:<PORT>`
- Cloudflare Access in front, with email-OTP policy (her email only)
- Useful when Tailscale install is undesirable

V1 implements Option A. Option B is documented but not scripted.

---

## 11. Sync, classification, drafting — exact behavior

### Sync triggers

- Service start: each enabled account runs `syncIncremental()`, then `startWatching()`.
- IMAP via IDLE: when IDLE fires, run `syncIncremental()` against that account.
- Gmail/Graph: poll every `agent.poll_interval_seconds` (default 60).
- Manual: `POST /api/v1/accounts/:id/resync`.

### After new messages are persisted

For each new inbound message:

1. Update `contacts` row (last_seen, message counts, first_seen if new).
2. Update `threads` row (last_message_at, last_inbound_at, message_count, participants).
3. If `agent.classify_on_inbound`, enqueue a classification job.
4. After classification, if `requires_response` AND `agent.autodraft_on_inbound` AND `contacts.do_not_auto_draft = false`, enqueue a draft job.

For each outbound message (whether sent by the agent or detected as sent externally):

1. Update `contacts` (message counts).
2. Update `threads` (last_outbound_at, state → `awaiting_their_reply`, sla_deadline recomputed).

### Classification job

Inputs assembled by `PromptAssembler.buildClassificationPrompt(messageId)`:

- System: `prompts/classifier.md` content
- User context block:
  - Contact name, category, notes (truncated to 500 chars)
  - Last 3 messages in thread, summarized to 200 chars each
  - New message: subject + body (truncated to 2000 chars if longer)
- Instruction: return JSON matching schema

Schema:

```json
{
  "intent": "inquiry|booking_request|scheduling|chitchat|question|complaint|other",
  "category_suggestion": "client_established|client_new|screening|personal|vendor|noise|unknown",
  "urgency": "low|normal|high",
  "requires_response": true,
  "summary": "<= 140 chars"
}
```

Calls `GatewayClient.complete()` with `format: 'json'`, validates against schema, retries once on parse failure with a stricter "JSON only" preamble. On second failure, logs an error and marks the thread `needs_classification` so the UI can prompt manually.

On success, applies state transition rules in §11.1, updates the thread row, writes `action_log` entry.

### Drafting job

Inputs assembled by `PromptAssembler.buildDraftPrompt(threadId, rawIntent?)`:

- System: `prompts/drafter.md` + the voice guide (loaded from `style_guide` setting or markdown file)
- Few-shot block: up to 3 examples from `style_examples` filtered by contact category, fall back to "any" if fewer than 3 match
- Context block:
  - Contact: name, category, notes, style notes, booking history (if applicable)
  - Thread history: condensed (each message: from + 1-2 sentence summary, plus full text of the message being replied to)
  - The inbound message in full
- Instruction block:
  - Tone target (derived from contact category)
  - Length target (1-3 paragraphs)
  - Raw intent if provided
- "Return only the email body. No preamble. No subject line."

Calls `GatewayClient.complete()` with `temperature` from settings. Writes a new `drafts` row with `version = max(existing)+1`, status `pending_review`. Emits SSE `draft:ready` event. Triggers Web Push to all subscriptions.

### State transition rules (§11.1)

| Event                            | Previous state         | New state              |
| -------------------------------- | ---------------------- | ---------------------- |
| Inbound, requires_response=true  | any                    | `awaiting_your_reply`  |
| Inbound, requires_response=false | `awaiting_their_reply` | `informational`        |
| Inbound, requires_response=false | `awaiting_your_reply`  | unchanged              |
| Outbound sent                    | any                    | `awaiting_their_reply` |
| Manual close                     | any                    | `closed`               |
| Manual schedule followup         | any                    | `scheduled_followup`   |

SLA recomputed on each state change using settings keys.

### Follow-up engine

Cron-style job runs every 5 minutes:

1. Find threads where `sla_deadline < now` AND `state IN ('awaiting_your_reply','awaiting_their_reply')` AND no `follow_ups` row exists with status='pending' for the same thread.
2. Insert a `follow_ups` row with reason `sla_breach`.
3. Emit SSE `thread:updated`.
4. Optionally send Web Push if urgency is high.

---

## 12. PWA design

### Information architecture

- **Default route**: `/needs-attention` — list of threads requiring her attention, each card showing contact name, agent summary, urgency, time since received, and a "Review draft" button if a draft exists.
- **Thread view**: `/threads/:id` — full conversation, with the latest inbound message and the current draft (editable) at the bottom. Send button is bottom-anchored, full-width, large tap target.
- **Inbox**: `/inbox` — optional full list, filterable by account and state.
- **Contacts**: `/contacts` — searchable list, tap to view/edit category and notes.
- **Follow-ups**: `/followups` — pending reminders.
- **Settings**: `/settings` — accounts, SLAs, voice guide, push, panic mode, backup.

### Mobile-first design

- Single-column layouts always. Tablet/desktop just centers content with max-width 720px.
- Bottom navigation bar (5 items: Needs Attention, Follow-ups, Inbox, Contacts, Settings) on mobile.
- Floating action bar above the bottom nav for thread-level actions when in a thread view.
- Tap targets minimum 44pt.
- Swipe gestures: on a thread card, swipe right to mark "I'll handle this manually" (dismisses the draft, marks thread `awaiting_your_reply` without an agent draft), swipe left to "snooze" (creates a scheduled_followup for +6h).

### Draft review screen

- Top: inbound message (collapsed by default, expandable, body text fully visible when expanded).
- Middle: draft body, editable `<textarea>`. Below it, the raw intent if any was provided.
- Action bar (sticky bottom): [Regenerate] [Edit raw intent] [Send].
- "Send" button is the primary CTA, full-width, bottom-anchored.
- Long-press send → modal: "Send this draft as-is?" Yes/Cancel. Prevents accidental sends.
- A small "diff" toggle shows what the agent changed vs raw intent if she provided one. Disabled if no raw intent.

### Voice input

- Use browser native `SpeechRecognition` API (works on Chrome Android, Safari iOS).
- Mic button on the "Edit raw intent" screen. Tap to start, tap to stop, transcript appears in the textarea.

### Push notifications

- One notification type in v1: "New draft ready for <contact name>". Tapping it opens the PWA directly to that thread.
- Quiet hours: configurable in settings, default 10pm–8am local time. During quiet hours, drafts still generate, no push fires.

### Service worker

- Workbox-generated, precaches the app shell + manifest.
- Runtime caches API responses (stale-while-revalidate, 5-minute max age).
- Queues failed POSTs (e.g., send draft) when offline; retries on reconnect.
- Shows an "offline, last synced X ago" banner when API requests fail.

### PWA manifest

- Name: "Secretary"
- Short name: "Secretary"
- Display: `standalone`
- Theme color and background color from style guide
- 192/512 icons (PNG, simple monogram for v1)
- Start URL: `/needs-attention`

---

## 13. Operator-side gateway: implementation specifics

### Configuration

Read from env vars (set via NSSM):

- `PORT` — gateway listen port (default 47823)
- `GATEWAY_API_KEY` — 64-char hex string
- `PAYLOAD_ENCRYPTION_KEY` — 64-char hex string
- `OLLAMA_URL` — default `http://localhost:11434`
- `OLLAMA_DEFAULT_MODEL` — default `qwen2.5:14b-instruct-q5_K_M`
- `OLLAMA_KEEP_ALIVE` — default `0` (unload immediately after each response, to free VRAM for ComfyUI)
- `LOG_LEVEL` — default `info`
- `LOG_PATH` — default `<userprofile>/secretary-gateway/logs/`

### Ollama interaction

- Use `/api/generate` for completions (single-turn). Pass `system` and `prompt` separately. Set `stream: false`.
- Pass `format: 'json'` or `format: <schema>` when requested.
- Pass `options.temperature`, `options.num_predict` (max_tokens).
- Pass `keep_alive: 0` in the request body so this specific request unloads after; honors a setting per request.

### Crypto

- AES-256-GCM via Node's built-in `crypto.createCipheriv`/`createDecipheriv`.
- Nonce: 12 random bytes per encryption, included in the envelope.
- Auth tag: 16 bytes, appended to ciphertext, separated on decryption.
- Shared with the service via `packages/shared-crypto`.

### NSSM install script

`infra/nssm/install-gateway.ps1` — installs the gateway as a Windows service named `secretary-gateway`. Takes parameters for env vars. Documented in `docs/ONBOARDING-OPERATOR.md`.

---

## 14. Phase plan (for Claude Code to execute in order)

Each phase has explicit acceptance criteria. Don't move to the next phase until criteria are met.

### Phase 0 — Bootstrap repository (1 evening)

1. Create monorepo structure exactly as in §4.
2. Set up `package.json`, `pnpm-workspace.yaml`, root `tsconfig.base.json`.
3. Add ESLint and Prettier configs (Airbnb base + Prettier).
4. Set up `.gitignore` for Node, Electron, build artifacts, `*.db`, `*.db-journal`, `.env*`.
5. Create `BRIEF.md` (this document) at the root.
6. Initialize `packages/shared-types`, `packages/shared-crypto`, `packages/llm-protocol` as empty TypeScript packages with their `package.json` and `tsconfig.json`.
7. README with high-level "what this is."

**Acceptance**: `pnpm install` at root succeeds; `pnpm -r typecheck` passes (no source yet).

### Phase 1 — Gateway (1 weekend)

1. Implement `apps/gateway/` per §8 and §13.
2. Implement `packages/shared-crypto` (AES-256-GCM wrap/unwrap functions, fully tested with vitest).
3. Implement `packages/llm-protocol` (TypeScript types for request/response envelopes).
4. Fastify server with two routes: `POST /v1/complete`, `GET /health`. (Gateway is single-turn only per §13; no separate chat route.)
5. API key + decryption middleware.
6. Ollama client.
7. Token-bucket rate limiter.
8. Pino logger, no body content logged.
9. Tests: unit tests for crypto, integration test that exercises `/v1/complete` with a mocked Ollama.
10. NSSM install script in `infra/nssm/`.
11. `docs/ONBOARDING-OPERATOR.md` with steps to:
    - Install Ollama, pull the default model
    - Set up Cloudflare Access service token
    - Configure cloudflared tunnel
    - Generate and store API key + encryption key
    - Install gateway as a service via NSSM
    - Verify with `curl` from a remote machine

**Acceptance**:

- Gateway responds to `curl https://llm.<operator-domain>/health` with model info, given Service Token headers.
- An encrypted `/v1/complete` request from a test script (in `apps/gateway/test/manual/`) returns a decrypted completion.
- Unit tests for crypto pass; round-trip encryption works.
- Gateway service auto-starts after Windows reboot.

### Phase 2 — Service skeleton + DB + LLM client (1 week)

1. `apps/service/electron/main.ts` — tray-only Electron shell. Tray menu: Open Secretary (opens default browser to served URL), Pause/Resume, View Logs, Quit. No `BrowserWindow`.
2. `apps/service/server/` — Fastify HTTPS server, mkcert-generated cert (script in `infra/mkcert/`).
3. SQLCipher database init: generate key on first run, store in keychain, open DB.
4. Migration runner + initial migration with all tables from §6.
5. Repositories pattern: one file per table with typed query functions. **Built just-in-time per phase** rather than all at once: Phase 2 ships only `SettingsRepository` and `PushSubscriptionRepository` (the tables it uses); the remaining tables get their repositories in the phases that consume them (Phases 3–6). The full schema is still created up front in the initial migration.
6. `GatewayClient` — calls the gateway with Cloudflare service token + API key + encryption. Reads credentials from keychain.
7. First-run setup flow:
   - On startup, check if Cloudflare credentials + gateway API key + encryption key + DB key all exist in keychain
   - If not, write a "needs setup" flag file
   - Tray menu shows "Setup required" instead of normal options
   - Opening Secretary shows a setup page in the PWA (Phase 2.5)
8. Logger (pino, rotating files, no content).
9. Service auth: bootstrap token written to a file on startup readable only by current user; PWA exchanges it for a session token via `POST /api/v1/auth/session`.
10. Settings endpoints (GET, PATCH).
11. Push subscription endpoints (subscribe/unsubscribe/test).
12. SSE endpoint scaffolding.

**Acceptance**:

- `pnpm dev` in `apps/service/` starts the Electron tray + Fastify HTTPS server.
- Tray icon appears on Mac and Windows.
- Visiting `https://localhost:<PORT>` in browser hits the server (will return a placeholder until Phase 2.5).
- DB file is encrypted (verified by trying to open without key — should fail).
- Calling the gateway via `GatewayClient` with test prompts works end-to-end.

### Phase 2.5 — PWA skeleton + setup wizard (3-4 evenings)

1. Vite + React + TS + Tailwind in `apps/service/pwa/`.
2. PWA manifest, service worker (Workbox precaching).
3. Bottom nav bar with placeholder routes.
4. Setup wizard at `/setup`:
   - Step 1: Welcome
   - Step 2: Paste Cloudflare Access service token (client ID + secret), test
   - Step 3: Paste gateway API key + payload encryption key, test full round-trip via gateway
   - Step 4: Generate VAPID keys, prompt for push permission
   - Step 5: Done
5. Each step writes to keychain via service API, never persists secrets in the PWA itself.
6. API client (TanStack Query hooks for each endpoint).
7. SSE connection management with auto-reconnect.

**Acceptance**:

- Installing fresh on her machine and opening the PWA leads through setup, ending in a working LLM round-trip and a registered push subscription.
- Reloading the PWA after setup goes to `/needs-attention` (empty state until accounts are added).

### Phase 3 — Proton via Bridge (1.5 weeks)

1. `ImapProvider` implementing `EmailProvider`.
2. IMAP add-account UI in PWA: explains Bridge requirement, probes `localhost:1143`, accepts email + Bridge password, tests login.
3. Initial sync: last 90 days from INBOX and Sent, deduplicated by Message-ID.
4. Threading reconstruction from In-Reply-To / References / normalized subject.
5. `imapflow` IDLE watcher; reconnects on disconnect with exponential backoff.
6. Contact extraction.
7. Send via SMTP through Bridge (localhost:1025).
8. Inbox view in PWA (sorted by last activity), thread view (read messages, no draft work yet).
9. Action log writes for every persisted message.

**Acceptance**:

- Adding her Proton account via the PWA wizard syncs the last 90 days of mail and shows it in the inbox view.
- Sending a test reply through the thread view (manually composed, no agent) successfully sends via Bridge.
- New mail arriving in Proton appears in the PWA within 15 seconds.

### Phase 4 — Classification + state machine + follow-ups (1 week)

1. `Classifier` with `prompts/classifier.md`. Implements §11.
2. State transition logic, SLA computation.
3. Follow-up engine (cron job).
4. `/api/v1/threads/needs-attention` endpoint.
5. PWA "Needs Attention" view becomes the default route, showing classified threads.
6. Manual category override on a contact updates future SLAs.

**Acceptance**:

- Inbound messages get classified within seconds of sync.
- Threads requiring response surface in Needs Attention sorted by urgency + SLA.
- SLA breaches generate follow_ups within 5 minutes of the deadline.
- Action log captures every classification.

### Phase 5 — Drafting + review + send (1.5 weeks)

1. `Drafter` with `prompts/drafter.md`. Implements §11.
2. Voice guide loading (markdown file in `apps/service/server/prompts/voice-baseline.md`, overridable from settings).
3. Few-shot block pulls from `style_examples` table (will be empty in v1; that's OK).
4. Draft endpoints: create, regenerate, edit, send, discard.
5. PWA thread view shows current draft, editable, with regenerate and send.
6. Raw intent input + diff view.
7. Long-press confirmation on send.
8. SSE `draft:ready` event triggers PWA to refresh that thread.

**Acceptance**:

- New inbound (requires_response=true, not on do-not-draft list) generates a draft within ~15 seconds.
- Draft is sent successfully via the underlying provider.
- After send, thread moves to `awaiting_their_reply` with new SLA.
- Editing a draft inline and sending uses the edited version.

### Phase 5.5 — Web Push and offline behavior (3-4 evenings)

1. VAPID keys generated, stored in keychain.
2. Push subscription endpoint accepts the PWA's subscription.
3. `WebPushSender` fires on `draft:ready` events.
4. Quiet hours setting.
5. PWA service worker handles offline action queueing for send requests.
6. "Offline" banner with last-sync timestamp.

**Acceptance**:

- New draft arrives → phone gets a Web Push notification within 30 seconds → tapping it opens the PWA directly to that thread.
- With phone in airplane mode, opening the PWA shows the last-loaded state and an offline banner.
- Re-enabling network triggers a re-sync.

### Phase 6 — Voice tuning tools (2 weeks initial)

1. Style guide editor in PWA settings (markdown editor, syntax-highlighted).
2. Per-contact `style_notes` editor.
3. Sent-mail mining job (one-time): processes last 200 sent messages, extracts style observations via LLM, writes to `style_examples`. Manual review UI.
4. `style_examples` retrieval at draft time (random sample within category for v1).
5. "Heavily edited" detection: if `final_body_sent` differs from `body_text` by >30% on send, log it for later analysis.
6. Optional: embedding-based example retrieval using sqlite-vec.

**Acceptance**:

- She can edit the style guide and changes affect future drafts immediately.
- Sent-mail mining populates style_examples with reasonable entries.
- Per-contact style notes appear in the draft prompt for that contact.

### Phase 7 — Gmail (3-5 evenings)

1. Google Cloud project setup documented in `docs/ONBOARDING-PRINCIPAL.md`.
2. `GmailProvider` implementing the interface.
3. OAuth loopback flow (ephemeral local HTTP server in service, browser opens Google consent, callback caught).
4. History API polling for new mail.
5. Add-account wizard step for Gmail.

**Acceptance**: adding a Gmail account syncs and behaves identically to the Proton account at the agent level.

### Phase 8 — Outlook/Hotmail/Graph (3-5 evenings)

1. Azure AD app registration documented.
2. `GraphProvider` implementing the interface.
3. MSAL OAuth flow.
4. Delta query polling.
5. Add-account wizard step for Microsoft.

**Acceptance**: adding a personal Microsoft account syncs and behaves identically.

### Phase 9 — Calendar awareness (1 week)

1. Calendar integration (Google Calendar API as the v1 target).
2. Classifier extracts `mentioned_datetimes`.
3. Availability lookup; drafter uses concrete availability in suggestions.

**Acceptance**: a message asking about availability gets a draft that references real open slots from her calendar.

### Phase 10 — Distribution (1 weekend)

1. `electron-builder` config for `.dmg` and NSIS `.exe`.
2. GitHub Actions workflow: build on tag, upload to private release.
3. `electron-updater` configured for that release channel.
4. `docs/ONBOARDING-PRINCIPAL.md` with install instructions including the "right-click → Open" / SmartScreen click-through note.

**Acceptance**: clean install on a fresh Mac and Windows machine completes setup wizard and reaches a working state.

---

## 15. What's explicitly out of scope for v1

- Multi-tenant or shared infrastructure
- Code signing / Apple notarization
- Real Cloudflare Tunnel automation on the principal's machine (Tailscale instead)
- Server push for Gmail/Graph (polling only)
- Cross-account thread linking
- Attachment body storage
- Embedding-based retrieval (added later in Phase 6 if useful)
- A "send immediately, no review" mode
- A desktop-optimized UI layout (responsive but mobile-first)
- Encrypted local backups (basic file-copy backup is fine for v1)
- Anything that uploads telemetry off her machine

---

## 16. Coding conventions

- TypeScript strict mode on every package, no `any` without comment justification.
- All async code uses `async/await`, not raw promises.
- Errors thrown with `Error` subclasses defined in `packages/shared-types/src/errors.ts`.
- All API routes return `{ data: ... }` on success or `{ error: { code, message } }` on failure. Status codes follow REST conventions.
- Date/time in storage: unix milliseconds (integers). In API JSON: ISO 8601 strings.
- All currency-like or sensitive numeric data: strings, not floats. (Probably not needed in v1, but noted.)
- Tests with `vitest`. Coverage target: 80% on packages, 60% on apps.
- Commits: conventional commits (`feat:`, `fix:`, `chore:`, etc.).

---

## 17. Definition of done for v1

- Operator can deploy gateway from a fresh Windows install in under 30 minutes following `docs/ONBOARDING-OPERATOR.md`.
- Principal can install the service on a fresh Mac/Windows in under 30 minutes following `docs/ONBOARDING-PRINCIPAL.md`, including Bridge + Tailscale setup.
- Adding her Proton, Gmail, and Outlook accounts works end-to-end.
- New inbound mail to any account: classified within seconds, drafted within ~15 seconds if eligible, push notification fires on her phone.
- She can review the draft on her phone, edit, and send. Round trip from "mail arrives" to "reply sent" under 60 seconds with no desktop interaction.
- All email content stays on her machine. Gateway never sees plaintext.
- Service runs continuously across reboots without manual intervention.

---

## 18. How to work with this brief

For Claude Code:

- Read this entire document before starting any session.
- When making implementation decisions, check the relevant section. If the brief doesn't cover the question, propose an answer in the PR description and update the brief in the same PR.
- Don't skip ahead between phases. Each phase has acceptance criteria; the next phase assumes they're met.
- Tests are mandatory for `packages/*` and for the agent (Classifier, Drafter, PromptAssembler, FollowUpEngine). API endpoints get integration tests. UI is manually tested in v1.
- When something in the brief is unclear or ambiguous, ask before guessing. Update the brief with the clarification.
