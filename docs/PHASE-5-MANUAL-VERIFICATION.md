# Phase 5 — Manual Verification (Drafting + Review + Send)

The automated suite covers the Drafter (fake gateway), the draft prompt, the diff util,
DraftsRepository, the auto-draft eligibility hook, and the draft routes. This runbook verifies
real draft generation + send end-to-end. PowerShell from `C:\Users\drice\Secretary`.

## Prerequisites

- Same as Phase 4: Node-ABI SQLite, HTTPS certs, the Gmail test account added, and the operator
  gateway running pointed at Ollama (start it with `GATEWAY_API_KEY`/`PAYLOAD_ENCRYPTION_KEY`
  matching the keychain and `OLLAMA_DEFAULT_MODEL=<your model>`).
- The service's `llm.model` set to your pulled model. Drafting uses `llm.temperature.draft` (0.5).
- For no-body POSTs, PowerShell needs `-ContentType 'application/json' -Body '{}'` (see Phase 4 note).

## 1. Start the service + session token

```powershell
$env:LOG_PRETTY = 'true'
pnpm --filter @secretary/service dev:server
```

Second terminal:

```powershell
$BOOT = (Get-Content "$env:USERPROFILE\.secretary\bootstrap-token.txt" -Raw).Trim()
$T = (Invoke-RestMethod -Method Post -Uri https://localhost:47824/api/v1/auth/session `
  -ContentType 'application/json' -Body (@{ bootstrapToken = $BOOT } | ConvertTo-Json)).data.token
$H = @{ authorization = "Bearer $T" }
```

Confirm `autodraft_on_inbound` is off (on-demand drafting):

```powershell
Invoke-RestMethod -Method Patch -Uri https://localhost:47824/api/v1/settings `
  -Headers $H -ContentType 'application/json' -Body (@{ 'agent.autodraft_on_inbound' = $false } | ConvertTo-Json)
```

## 2. Create a draft on demand

Pick a thread that needs a reply:

```powershell
$TH = (Invoke-RestMethod -Uri https://localhost:47824/api/v1/threads/needs-attention -Headers $H).data[0].id
$draft = (Invoke-RestMethod -Method Post -Uri https://localhost:47824/api/v1/drafts `
  -Headers $H -ContentType 'application/json' -Body (@{ threadId = $TH } | ConvertTo-Json)).data
$draft | Format-List version, subject, status, @{n='to';e={$_.to.address}}, bodyText
```

Expect a `pending_review` draft, `Re: <subject>`, addressed to the inbound sender, with an
LLM-written body. (Quality is rough on the 1.5B model; that's expected.)

With a dictated intent (polish + diff):

```powershell
$d2 = (Invoke-RestMethod -Method Post -Uri https://localhost:47824/api/v1/drafts `
  -Headers $H -ContentType 'application/json' -Body (@{ threadId = $TH; rawIntent = 'politely decline, suggest next month' } | ConvertTo-Json)).data
$d2.polishDiff | Format-Table op, line
```

## 3. Edit + send

```powershell
Invoke-RestMethod -Method Patch -Uri "https://localhost:47824/api/v1/drafts/$($draft.id)" `
  -Headers $H -ContentType 'application/json' -Body (@{ bodyText = 'Edited final body. — sending test' } | ConvertTo-Json)

Invoke-RestMethod -Method Post -Uri "https://localhost:47824/api/v1/drafts/$($draft.id)/send" `
  -Headers $H -ContentType 'application/json' -Body '{}'
```

Expect `{ providerMessageId, threadState: 'awaiting_their_reply' }`. Confirm the email arrives at the
recipient, and the thread is now `awaiting_their_reply`:

```powershell
(Invoke-RestMethod -Uri "https://localhost:47824/api/v1/threads/$TH" -Headers $H).data.state
```

## 4. (Optional) Verify the auto-draft path

```powershell
Invoke-RestMethod -Method Patch -Uri https://localhost:47824/api/v1/settings `
  -Headers $H -ContentType 'application/json' -Body (@{ 'agent.autodraft_on_inbound' = $true } | ConvertTo-Json)
# Re-classify a thread that needs a response; within a few seconds a draft should appear.
Invoke-RestMethod -Method Post -Uri "https://localhost:47824/api/v1/threads/$TH/classify" `
  -Headers $H -ContentType 'application/json' -Body '{}'
```

(Then flip it back to `$false` if you want on-demand again.)

## Acceptance (BRIEF §14 Phase 5)

- New inbound (eligible) generates a draft (auto path, step 4) / on-demand (step 2). ✅
- Draft sent via the provider (step 3). ✅
- After send, thread → `awaiting_their_reply` (step 3). ✅
- Editing inline and sending uses the edited body (step 3 — `final_body_sent`). ✅
