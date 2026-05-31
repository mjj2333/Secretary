# Phase 3 — Manual Verification (Generic IMAP: Gmail now, Proton Bridge later)

The automated suite covers the pure logic, repositories, SyncManager (via a fake provider), and the
API routes. The real IMAP/SMTP interop in `ImapProvider` is verified here, against a live mailbox.
All commands are PowerShell from the repo root `C:\Users\drice\Secretary`.

## Prerequisites

- **Native SQLite on Node ABI.** The service's `better-sqlite3-multiple-ciphers` must match plain
  Node (not Electron). If you previously ran `rebuild:electron` (for the tray), restore the Node
  build first: `pnpm --filter @secretary/service rebuild` (or reinstall). Running tests/`dev:server`
  and the Electron tray require different ABIs — you can't have both at once.
- **HTTPS certs** from Phase 2 (`infra/mkcert/setup-certs.ps1`).
- A test mailbox: a **Gmail app password** (now) or **Proton Bridge** (later).

## 1. Start the service

```powershell
$env:LOG_PRETTY = 'true'
pnpm --filter @secretary/service dev:server
```

Expect `service listening port: 47824`. On startup the service writes a single-use bootstrap token to
`C:\Users\<you>\.secretary\bootstrap-token.txt`. Leave the service running; use a second terminal below.

## 2. Get a session token

```powershell
$BOOT = (Get-Content "$env:USERPROFILE\.secretary\bootstrap-token.txt" -Raw).Trim()
$resp = curl.exe -k -s -X POST https://localhost:47824/api/v1/auth/session `
  -H "content-type: application/json" -d "{ ""bootstrapToken"": ""$BOOT"" }" | ConvertFrom-Json
$T = $resp.data.token
$T   # your session token (the bootstrap token is now consumed)
```

If you restart the service, a fresh bootstrap token is written — re-run this step.

## 3. Add a mailbox

### Gmail (over IMAP — works today)

Enable IMAP in Gmail settings and create an **app password** (requires 2-Step Verification).

```powershell
curl.exe -k -X POST https://localhost:47824/api/v1/accounts/imap `
  -H "authorization: Bearer $T" -H "content-type: application/json" `
  -d '{ "displayName":"Gmail test","emailAddress":"you@gmail.com","imapHost":"imap.gmail.com","imapPort":993,"useTls":true,"smtpHost":"smtp.gmail.com","smtpPort":465,"password":"<app password, no spaces>" }'
```

### Proton Bridge (later, needs the paid account + Bridge running)

```powershell
curl.exe -k -X POST https://localhost:47824/api/v1/accounts/imap `
  -H "authorization: Bearer $T" -H "content-type: application/json" `
  -d '{ "displayName":"Proton","emailAddress":"you@proton.me","imapHost":"127.0.0.1","imapPort":1143,"useTls":false,"smtpHost":"127.0.0.1","smtpPort":1025,"password":"<Bridge password>" }'
```

A `200` with `{ "data": { "id": "...", "syncState": "syncing" } }` means the connection succeeded and the
initial 90-day sync started in the background. A `400 imap_connection_failed` means bad host/credentials
(nothing is persisted). Note the returned account `id`.

## 4. Watch the sync land

After a few seconds:

```powershell
curl.exe -k https://localhost:47824/api/v1/threads -H "authorization: Bearer $T"
```

You should see synced threads (sorted newest first). View one with its messages:

```powershell
curl.exe -k https://localhost:47824/api/v1/threads/<thread id> -H "authorization: Bearer $T"
```

**Live new mail:** send yourself a new email to that mailbox; within ~15s it should appear in
`GET /threads` (the IDLE watcher triggers an incremental sync).

## 5. Send a reply

```powershell
curl.exe -k -X POST https://localhost:47824/api/v1/accounts/<account id>/send `
  -H "authorization: Bearer $T" -H "content-type: application/json" `
  -d '{ "to":[{"address":"someone@example.com"}],"subject":"Test from Secretary","bodyText":"hello" }'
```

A `200` with `{ "data": { "providerMessageId": "..." } }` means it sent. Check the recipient inbox.

## Acceptance (BRIEF §14 Phase 3)

- Adding the IMAP account syncs the last 90 days and they show via `GET /threads`. ✅ (steps 3–4)
- A manually-composed reply sends via the provider. ✅ (step 5)
- New mail appears within ~15s (IDLE watcher). ✅ (step 4)
- Threading, contacts, and the action log are populated correctly. ✅ (automated: SyncManager + repository tests)

## Cleanup

```powershell
curl.exe -k -X DELETE https://localhost:47824/api/v1/accounts/<account id> -H "authorization: Bearer $T"
```

Removes the account, its synced messages/threads (FK cascade), and the keychain password.
