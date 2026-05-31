# Phase 2 — Service Skeleton + DB + LLM Client — Design

**Date:** 2026-05-30
**Status:** Approved (pending spec review)
**Brief reference:** `BRIEF.md` §14 Phase 2, with cross-cutting detail from §3, §5, §6, §9, §13, §16.

## Context

Phase 0 (monorepo bootstrap) and Phase 1 (operator gateway + `shared-crypto`, `llm-protocol`, `shared-types`) are complete and verified (typecheck clean, 72 tests passing). This phase builds the principal-side **service skeleton**: the Electron tray shell, the Fastify HTTPS server, the encrypted SQLite database, the gateway client, first-run setup detection, and the auth/settings/push/SSE plumbing the PWA (Phase 2.5) will consume.

There is no `apps/service/` directory yet; it is created from scratch in this phase.

### Platform decision

The product remains **cross-platform** (macOS + Windows per brief §3). **Windows is the first platform we run and test on.** No change to the brief is required — the chosen stack (Electron, `better-sqlite3-multiple-ciphers`, `@napi-rs/keyring`, mkcert) is already portable. The design isolates the few platform-divergent pieces behind small seams so the macOS port is packaging + a cert script, not a rewrite.

### Resolved design decisions

- **Gateway connectivity for dev:** local-direct. The service talks to a Phase 1 gateway running on the same Windows machine at `http://localhost:<port>`, skipping the Cloudflare tunnel. The real auth/crypto path (`X-API-Key` + AES-256-GCM payload) is still exercised; only the Cloudflare Access Service Token headers are omitted.
- **Process model:** headless server core (runs in plain Node) + thin Electron tray that supervises the server child when packaged.
- **① Repositories built just-in-time per phase** (not all 11 tables up front).
- **② GatewayClient URL + CF headers are config-driven** (local-direct now, Cloudflare path is config-only later).
- **③ Desktop bootstrap→session via tray-opened browser URL fragment** (token also written to file per brief, for later phone pairing).

## Goals (this phase)

Deliver a runnable principal service that:

1. Starts as an Electron tray app (no `BrowserWindow`) on Windows, with menu: Open Secretary, Pause/Resume, View Logs, Quit.
2. Serves a Fastify HTTPS server (mkcert cert) that responds at `https://localhost:<port>` with a placeholder page.
3. Creates and opens a SQLCipher-encrypted database, runs migrations that lay down all §6 tables, and seeds settings defaults.
4. Provides a `GatewayClient` that performs an end-to-end encrypted round-trip to a local gateway.
5. Detects first-run (missing secrets) and surfaces "Setup required" in the tray + placeholder page.
6. Exposes the Phase 2 API subset: auth (bootstrap→session), settings, push subscribe/unsubscribe/test, SSE events, health.

## Non-goals (deferred to later phases)

- The real PWA UI and setup wizard (Phase 2.5).
- Email providers, sync, classification, drafting (Phases 3–6).
- Actual Web Push sending + VAPID generation (Phase 5.5) — Phase 2 stores subscriptions and stubs `push/test`.
- Auto-launch-on-login registration and packaging/installers (Phase 10).
- Repositories for tables with no Phase 2 consumer (built in their phases).

## Architecture

### Directory layout

```
apps/service/
  package.json
  electron/
    main.ts            # thin tray: spawn + supervise server child, app lifecycle
    tray-menu.ts       # menu construction + state (normal | setup-required | paused)
    server-process.ts  # fork server child, await "ready {port}" signal, restart on crash
  server/
    index.ts           # headless entrypoint — runs in plain Node OR as Electron-forked child
    config.ts          # env + defaults (port, paths, gateway URL/mode, log level)
    server.ts          # Fastify HTTPS instance, plugins (CORS, {data}/{error} envelope), routes
    httpsOptions.ts    # load mkcert cert + key from config paths
    eventBus.ts        # in-process EventEmitter feeding SSE
    api/
      index.ts         # registers all routes under /api/v1
      health.ts        # GET /api/v1/health (unauth)
      auth.ts          # POST + DELETE /api/v1/auth/session
      settings.ts      # GET + PATCH /api/v1/settings
      push.ts          # POST + DELETE /api/v1/push/subscribe, POST /api/v1/push/test
      events.ts        # GET /api/v1/events (SSE)
    auth/
      KeychainStore.ts # @napi-rs/keyring wrapper, keyed secretary.<id>.<purpose>
    crypto/
      SessionTokens.ts # bootstrap token + session token issue/validate
    llm/
      GatewayClient.ts # URL/CF-header config + API key + AES-GCM (shared-crypto) + llm-protocol
    db/
      connection.ts    # open SQLCipher with key from keychain, run migrations + seed
      migrate.ts       # migration runner (_migrations table)
      migrations/
        0001_init.sql  # ALL §6 tables + indexes
      seed.ts          # seed settings defaults (idempotent)
      schema.ts        # TS row types for all tables
      repositories/
        SettingsRepository.ts
        PushSubscriptionRepository.ts
    setup/
      firstRun.ts      # check keychain for required secrets; manage needs-setup flag file
    logger.ts          # pino rotating file, metadata only
  pwa/
    index.html         # placeholder "service running / setup required" page (real PWA = 2.5)
  tsconfig.json
  vitest.config.ts
infra/mkcert/
  setup-certs.ps1      # mkcert -install + generate localhost/127.0.0.1 cert into dev cert dir
  README.md
```

### Process model & dev workflow

Two run modes, sharing the same `server/` code:

- **`pnpm dev:server`** — runs `server/index.ts` in plain Node via `tsx` watch, against dev certs and dev config. Primary dev surface for the DB, GatewayClient, and API work; verifies the DB-encryption and gateway acceptance criteria. No Electron, no native-module rebuild.
- **`pnpm dev`** — boots the Electron tray (`electron/main.ts`), which forks the server child via `server-process.ts` and shows the tray icon (satisfies the "tray appears" acceptance). Requires a one-time `pnpm rebuild:electron` so `better-sqlite3-multiple-ciphers` loads under Electron's ABI.

When packaged, Electron forks the server using its bundled Node (`ELECTRON_RUN_AS_NODE`), so native modules are rebuilt against Electron's ABI at package time (Phase 10). Dev under plain Node uses the standard Node-ABI binary.

**Windows risk (flagged for early verification):** the Electron rebuild may require Visual Studio Build Tools if no matching Electron prebuilt binary downloads for `better-sqlite3-multiple-ciphers`. The `dev:server` (plain Node) path avoids this, so core development is never blocked on it. The implementation plan must verify native-module loading on this machine as its first step.

## Component specifications

### config.ts

Reads from env with defaults. Non-secret config only (secrets come from keychain; tunable settings come from the DB).

- `SERVICE_PORT` — default `47824` (gateway uses `47823`).
- `SERVICE_DATA_DIR` — default OS userData dir; holds `secretary.db`, logs, bootstrap-token file, needs-setup flag.
- `SERVICE_CERT_PATH` / `SERVICE_KEY_PATH` — mkcert cert/key paths; default to dev cert dir in dev, userData in packaged.
- `GATEWAY_URL` — dev fallback, default `http://localhost:47823` (local-direct).
- `GATEWAY_USE_CF_HEADERS` — default `false` in dev; `true` for the Cloudflare path.
- `LOG_LEVEL` — default `info`.

**Gateway URL resolution (explicit):** `GatewayClient` resolves its target URL as the DB setting `llm.gateway_url` if set (the production/onboarding value), otherwise the env `GATEWAY_URL` (the dev fallback above). The settings value wins so onboarding can point at the Cloudflare URL without an env change; the env fallback keeps local-direct dev zero-config. `GATEWAY_USE_CF_HEADERS` likewise defaults from env but is overridable by a settings key once onboarding exists.

### db/ — database layer

- `connection.ts`: fetches the DB key from `KeychainStore` (generating + storing a 32-byte random key on first run), opens `better-sqlite3-multiple-ciphers` with `PRAGMA key`, sets SQLCipher-compatible pragmas, then runs `migrate` + `seed`.
- `migrate.ts`: reads `migrations/*.sql` in order, tracks applied versions in `_migrations`, applies pending ones in a transaction.
- `migrations/0001_init.sql`: creates **all** §6 tables (`accounts`, `messages`, `threads`, `contacts`, `drafts`, `follow_ups`, `action_log`, `settings`, `push_subscriptions`, `style_examples`) with their CHECK constraints and indexes exactly as specified. Schema-complete now; migrations are append-only thereafter.
- `seed.ts`: idempotently inserts the §6 default settings keys (classify/autodraft flags, poll interval, SLA windows, LLM model/temperatures, web-push disabled). `llm.gateway_url` left unset until onboarding.
- `schema.ts`: TypeScript row types for all tables.
- `repositories/`: **Phase 2 builds only** `SettingsRepository` (typed get/getAll/set/patch over the JSON `value` column) and `PushSubscriptionRepository` (insert/delete-by-endpoint/list). Other tables' repositories are added in the phases that consume them.

**Acceptance hook:** a test opens the DB file with a wrong key and asserts the open fails, proving at-rest encryption.

### llm/GatewayClient.ts

- Constructed from config (`GATEWAY_URL`, `GATEWAY_USE_CF_HEADERS`) + creds from `KeychainStore` (gateway API key, payload encryption key, and — only when CF headers are enabled — the CF Service Token id/secret).
- `complete(req)`: builds the `llm-protocol` request envelope, encrypts the body with `shared-crypto` AES-256-GCM, POSTs to `${GATEWAY_URL}/v1/complete` with `Content-Type: application/cf-encrypted+json`, `X-API-Key`, and (conditionally) `CF-Access-Client-Id` / `CF-Access-Client-Secret`. Decrypts and validates the response envelope.
- One retry on transient/network failure; throws typed errors from `shared-types/errors.ts`.

**Acceptance hook:** an integration test runs a local fake gateway (a tiny Fastify app that decrypts the payload, returns a canned completion encrypted with the same key) and asserts a clean round-trip. This satisfies the Phase 2 "calling the gateway works end-to-end" criterion against the local-direct setup.

### auth/KeychainStore.ts + crypto/SessionTokens.ts

- `KeychainStore`: thin wrapper over `@napi-rs/keyring`, keys formatted `secretary.<accountId|service>.<purpose>`. Methods: `get`, `set`, `delete`, `has`. Used for DB key, gateway API key, payload key, CF token.
- `SessionTokens`:
  - On startup, generates a **one-time bootstrap token**, writes it to a userData file (best-effort restrictive perms; on Windows the userData path is already per-user) and holds it in memory.
  - `POST /api/v1/auth/session` accepts the bootstrap token, validates it, issues a long-lived random **session token**, returns `{ token, expiresAt }`. Bootstrap token is single-use.
  - `DELETE /api/v1/auth/session` revokes the presented session token.
  - Session tokens validated on every non-health request (Fastify `preHandler`).

### API surface (Phase 2 subset of §9)

Mounted under `/api/v1`. All routes except `health` require `Authorization: Bearer <session>` and strict CORS to the served origin. Success → `{ data }`, failure → `{ error: { code, message } }` (brief §16).

- `GET /api/v1/health` — unauth; `{ data: { ok, version } }`.
- `POST /api/v1/auth/session` / `DELETE /api/v1/auth/session`.
- `GET /api/v1/settings` (all) / `PATCH /api/v1/settings` (partial merge).
- `POST /api/v1/push/subscribe` (store subscription) / `DELETE /api/v1/push/subscribe/:endpoint`.
- `POST /api/v1/push/test` — returns a graceful "push not configured" error until VAPID exists (Phase 5.5).
- `GET /api/v1/events` — SSE stream with heartbeat + connection management; fed by `eventBus`. Real domain events emitted in later phases.

### electron/ — tray shell

- `main.ts`: no `BrowserWindow`. Creates the tray, builds the menu via `tray-menu.ts`, forks the server via `server-process.ts`, reflects server/setup state in the menu.
- `tray-menu.ts`: menu items — **Open Secretary** (opens default browser to `https://localhost:<port>/#bootstrap=<one-time-token>`), **Pause/Resume**, **View Logs**, **Quit**. In needs-setup state the menu shows "Setup required" and Open Secretary points at the placeholder/setup page.
- `server-process.ts`: forks the server child, awaits a `ready {port}` message, restarts on unexpected exit (bounded backoff), forwards Pause/Resume.

### Bootstrap→session flow (desktop)

1. Server generates a one-time bootstrap token on startup.
2. User clicks **Open Secretary** → browser opens `https://localhost:<port>/#bootstrap=<token>`.
3. The page (placeholder now; PWA in 2.5) reads the fragment, calls `POST /api/v1/auth/session`, stores the session token, clears the fragment.
4. Token is also written to the userData file for the future phone-pairing flow.

### logger.ts

`pino` with a rotating file transport in the userData logs dir. Logs metadata only — ids, timestamps, durations, status codes. **Never** message bodies, prompts, completions, or token content.

### Cross-platform seams

- `KeychainStore` (napi-rs) — Windows Credential Manager now, macOS Keychain later, zero platform code.
- Certs — `infra/mkcert/setup-certs.ps1` (Windows now); cert paths are config-driven, so a `.sh` equivalent is the only macOS addition.
- Auto-launch — Electron's cross-platform `app.setLoginItemSettings` (wired in Phase 10).
- Packaging — `electron-builder` targets (Phase 10).

## Testing strategy

Vitest in `apps/service`. Coverage target 60% (apps) per brief §16.

- **db:** migration runner applies all migrations and is idempotent; SQLCipher wrong-key open fails; `SettingsRepository` get/set/patch round-trips; `PushSubscriptionRepository` insert/list/delete.
- **GatewayClient:** end-to-end round-trip against a local fake gateway (encrypt → decrypt → respond → decrypt); typed error on failure; one-retry behavior.
- **auth:** bootstrap→session exchange, single-use bootstrap, session validation + expiry, revoke.
- **api (Fastify `inject`):** settings GET/PATCH, push subscribe/unsubscribe, health; unauthorized requests rejected; CORS origin enforced.

UI (tray, placeholder page) is manually verified on Windows per brief §16.

## Acceptance criteria (brief §14 Phase 2) → how met

| Criterion                                              | Met by                                                                        |
| ------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `pnpm dev` starts Electron tray + Fastify HTTPS server | `electron/main.ts` + `server-process.ts` fork; manual check                   |
| Tray icon appears (Windows)                            | Tray created in `main.ts`; manual check                                       |
| `https://localhost:<port>` hits server (placeholder)   | `pwa/index.html` served over mkcert HTTPS                                     |
| DB file encrypted (open without key fails)             | SQLCipher + wrong-key test                                                    |
| `GatewayClient` works end-to-end with test prompts     | Local fake-gateway integration test + manual round-trip against local gateway |

## Risks & mitigations

- **Native module / Electron ABI on Windows** — verify load first; `dev:server` (plain Node) unblocks core work; `rebuild:electron` handled before the `pnpm dev` acceptance check.
- **mkcert not installed** — `setup-certs.ps1` runs `mkcert -install`; server gives a clear error if cert paths are missing.
- **Bootstrap token leakage via URL fragment** — single-use, short-lived, never sent to the server in query (fragment stays client-side until the explicit exchange POST); cleared after exchange.

```

```
