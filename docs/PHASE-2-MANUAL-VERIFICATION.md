# Phase 2 — Manual Verification (Windows)

The automated suite (`pnpm -r typecheck`, `pnpm -r test`, `pnpm lint`, `pnpm format:check`)
covers everything that can run headless. The steps below are the on-machine checks that need a
real environment (HTTPS certs, a running gateway + Ollama, the Electron GUI). All commands are
PowerShell, run from the repo root `C:\Users\drice\Secretary` unless noted.

## Prerequisites

```powershell
node -v    # v20+
pnpm -v    # 9+
```

**mkcert** (local HTTPS cert tool). Windows 11 has `winget` built in — no admin and no Chocolatey needed:

```powershell
winget install --id FiloSottile.mkcert --exact --accept-source-agreements --accept-package-agreements
```

> winget updates your PATH and adds a `mkcert` alias. **Open a new terminal afterward** so the PATH
> change takes effect.

**Ollama** (needed only for Part C) — installed and running, with a model pulled. Check what you have:

```powershell
ollama list
```

If `ollama` isn't recognized, open a fresh terminal (PATH), or confirm the server is up with
`Invoke-RestMethod http://localhost:11434/api/tags`.

## Part A — HTTPS certificates

```powershell
powershell -File infra\mkcert\setup-certs.ps1
```

- Use `powershell -File` (Windows PowerShell 5.1); PowerShell 7 (`pwsh`) is not required.
- The first run of `mkcert -install` may pop a one-time Windows dialog to trust the local root CA — click **Yes** (per-user, no admin).
- Writes `localhost.pem` + `localhost-key.pem` to `C:\Users\<you>\.secretary\certs`.

## Part B — Service over HTTPS

**Terminal 1** — start the headless server with console logging on (otherwise it logs to a file and the terminal looks idle):

```powershell
$env:LOG_PRETTY = 'true'
pnpm --filter @secretary/service dev:server
```

Expected:

```
INFO: first-run evaluated  needsSetup: true  ...
INFO: service listening  port: 47824
```

`needsSetup: true` is correct until Part C stores the gateway secrets. Leave it running.

**Terminal 2** (new window):

```powershell
curl.exe -k https://localhost:47824/api/v1/health      # -> {"data":{"ok":true}}
curl.exe -k https://localhost:47824/api/v1/settings     # -> {"error":{"code":"unauthorized",...}}
```

Open `https://localhost:47824/` in a browser → the "Secretary — Service is running" placeholder.

> **Cert warning in the browser?** Harmless. Chrome/Edge load the trust store at launch — fully quit
> and reopen so the new mkcert CA is picked up. Firefox uses its own store (mkcert can't install into
> it here); use Chrome/Edge or set `security.enterprise_roots.enabled = true` in Firefox `about:config`.

Stop with **Ctrl+C** (you'll see `INFO: shutting down` — graceful shutdown).

## Part C — Encrypted gateway round-trip (key acceptance check)

Exercises service → gateway → Ollama → service, end to end, with matching secrets on both sides.

**1. Generate two shared secrets** (copy both; you paste each in two places):

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # API_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # PAYLOAD_KEY
```

**2. Start the gateway** — Terminal A. **Quote every value** (PowerShell treats an unquoted hex string as a command):

```powershell
$env:GATEWAY_API_KEY        = '<API_KEY>'
$env:PAYLOAD_ENCRYPTION_KEY = '<PAYLOAD_KEY>'
pnpm --filter @secretary/gateway dev
```

Sanity check: `curl.exe http://localhost:47823/health` → `{"ok":true,...}`.

**3. Store the SAME secrets in the service keychain** — Terminal B:

```powershell
pnpm --filter @secretary/service set-secret app.gateway-api-key '<API_KEY>'
pnpm --filter @secretary/service set-secret app.payload-key     '<PAYLOAD_KEY>'
```

**4. Run the round-trip** — Terminal B, using whatever model you have pulled:

```powershell
$env:GATEWAY_TEST_MODEL = 'qwen2.5:1.5b-instruct'
pnpm --filter @secretary/service exec tsx test/manual/gateway-round-trip.ts
```

Expected — a decrypted completion:

```
{ response: 'Hello there!', model: 'qwen2.5:1.5b-instruct', tokens_in: 36, tokens_out: 4, duration_ms: ... }
```

Troubleshooting:

- `Gateway returned 401` — keychain `app.gateway-api-key` ≠ the gateway's `GATEWAY_API_KEY`.
- `DecryptionError` / `decryption_failed` — the payload keys don't match between keychain and gateway.
- Connection refused on 47823 — the gateway (Terminal A) isn't up.

## Part D — Electron tray

```powershell
pnpm --filter @secretary/service build            # tsc + copies pwa/migrations/icon into dist
pnpm --filter @secretary/service rebuild:electron # native sqlite for Electron's ABI (one-time)
pnpm --filter @secretary/service dev              # launches the tray (electron .)
```

- If `rebuild:electron` fails with a compiler error, install **Visual Studio Build Tools** ("Desktop
  development with C++"), then re-run. Only the Electron path needs this; `dev:server` is unaffected.
- A **Secretary** tray icon appears (no app window — tray-only). Right-click → Open Secretary · Pause ·
  View Logs · Quit. "Open Secretary" opens the placeholder page; "Quit" stops the forked server cleanly.

## Acceptance criteria (BRIEF §14 Phase 2) → status

| Criterion                                          | Verified by                      |
| -------------------------------------------------- | -------------------------------- |
| `pnpm dev` starts Electron tray + Fastify HTTPS    | Part D                           |
| Tray icon appears (Windows)                        | Part D                           |
| `https://localhost:<port>` serves the placeholder  | Part B                           |
| DB file encrypted (open without key fails)         | `connection.test.ts` (automated) |
| `GatewayClient` works end-to-end with test prompts | Part C                           |
