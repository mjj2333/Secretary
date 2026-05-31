# Phase 4 — Manual Verification (Classification + State Machine + Follow-ups)

The automated suite covers the agent logic (state machine, SLA, classifier with a fake gateway,
queue, follow-up engine) and the routes. This runbook verifies real LLM classification end-to-end
against the operator's Ollama. All commands are PowerShell from the repo root
`C:\Users\drice\Secretary`. Prerequisites are the same as Phase 3 (Node-ABI SQLite, HTTPS certs,
the Gmail test account already added).

## 0. Point the gateway at a real model

Classification calls the gateway, which forwards to Ollama. Set the classifier model to the model
you actually have pulled (the seeded default is `qwen2.5:14b-instruct-q5_K_M`; a small model like
`qwen2.5:1.5b` proves the pipeline, with rougher quality). Gateway credentials must be in the
keychain (from Phase 2 setup); if they are absent, classification is skipped and threads stay
`needs_classification`.

## 1. Start the service + get a session token

```powershell
$env:LOG_PRETTY = 'true'
pnpm --filter @secretary/service dev:server
```

In a second terminal:

```powershell
$BOOT = (Get-Content "$env:USERPROFILE\.secretary\bootstrap-token.txt" -Raw).Trim()
$T = (Invoke-RestMethod -Method Post -Uri https://localhost:47824/api/v1/auth/session `
  -ContentType 'application/json' -Body (@{ bootstrapToken = $BOOT } | ConvertTo-Json)).data.token
```

Set the classifier model (use your pulled model):

```powershell
Invoke-RestMethod -Method Patch -Uri https://localhost:47824/api/v1/settings `
  -Headers @{ authorization = "Bearer $T" } -ContentType 'application/json' `
  -Body (@{ 'llm.model' = 'qwen2.5:1.5b' } | ConvertTo-Json)
```

## 2. Trigger classification

Re-sync the Gmail account so the backlog routes through classification (or send yourself a new
email and wait for the IDLE watcher):

```powershell
$ACC = (Invoke-RestMethod -Uri https://localhost:47824/api/v1/accounts -Headers @{ authorization = "Bearer $T" }).data[0].id
# NOTE: PowerShell's Invoke-RestMethod adds a form content-type on a body-less POST, which the
# server rejects with 415. For no-body POSTs always pass `-ContentType 'application/json' -Body '{}'`.
Invoke-RestMethod -Method Post -Uri "https://localhost:47824/api/v1/accounts/$ACC/resync" `
  -Headers @{ authorization = "Bearer $T" } -ContentType 'application/json' -Body '{}'
```

Watch the service log: you should see classification activity. Because the queue is sequential and
the model unloads between calls (`keep_alive: 0`), a large backlog drains slowly — that's expected.

## 3. Verify Needs Attention

```powershell
(Invoke-RestMethod -Uri https://localhost:47824/api/v1/threads/needs-attention -Headers @{ authorization = "Bearer $T" }).data |
  Format-Table id, state, urgency, slaDeadline, summary, hasPendingFollowUp
```

Expect threads that need a reply, ordered by urgency (high first) then SLA (soonest first), each with
an agent `summary`. Threads where you sent the last message should NOT appear (they are
`awaiting_their_reply`).

## 4. Verify a single thread's classification

```powershell
$TH = (Invoke-RestMethod -Uri https://localhost:47824/api/v1/threads/needs-attention -Headers @{ authorization = "Bearer $T" }).data[0].id
(Invoke-RestMethod -Uri "https://localhost:47824/api/v1/threads/$TH" -Headers @{ authorization = "Bearer $T" }).data | Format-List state, subject
# Re-classify on demand (no-body POST → pass an empty JSON body, see the note in step 2):
Invoke-RestMethod -Method Post -Uri "https://localhost:47824/api/v1/threads/$TH/classify" `
  -Headers @{ authorization = "Bearer $T" } -ContentType 'application/json' -Body '{}'
```

## 5. Verify SLA follow-ups

Overdue backlog threads (deadline in the past) should produce `follow_ups` within 5 minutes (the
engine tick). Confirm via the action log / DB, or simply re-check `needs-attention` after a few
minutes — newly-breached threads gain `hasPendingFollowUp: true`.

## 6. Verify the contact category override

```powershell
$C = (Invoke-RestMethod -Uri https://localhost:47824/api/v1/contacts -Headers @{ authorization = "Bearer $T" }).data[0].id
Invoke-RestMethod -Method Patch -Uri "https://localhost:47824/api/v1/contacts/$C" `
  -Headers @{ authorization = "Bearer $T" } -ContentType 'application/json' `
  -Body (@{ category = 'client_new' } | ConvertTo-Json)
```

A subsequent inbound from that contact (or a manual re-classify that lands `awaiting_your_reply`)
should use the tighter `client_new` 4-hour SLA on its next transition.

## Acceptance (BRIEF §14 Phase 4)

- Inbound messages get classified within seconds of sync (step 2–3). ✅
- Threads requiring a response surface in Needs Attention, urgency + SLA ordered (step 3). ✅
- SLA breaches generate follow-ups within 5 minutes (step 5). ✅
- Action log captures every classification (`action='classified'`). ✅ (automated + DB check)
- Manual category override updates future SLAs (step 6). ✅
