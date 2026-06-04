# Phase 6b — Manual Verification (Sent-Mail Mining + Review + Heavy-Edit)

Server + PWA logic is unit-tested (210 service tests, 20 PWA tests, clean PWA build). This runbook covers
the three live behaviors plus the deferred Phase 6a UI spot-check. PowerShell from `C:\Users\drice\Secretary`.
Prereqs: the service running; the operator gateway + Ollama up (mining and draft-shaping both need the LLM —
see the memory note on starting the gateway from the keychain).

## Setup (dev loop)

```powershell
pnpm --filter @secretary/service dev:server
pnpm --filter @secretary/pwa dev
```

Open http://localhost:5173 and connect with the bootstrap token.

> GPU note: the mining job shares the single GPU with live classify/draft (one call per lane). Run it when
> you're not actively waiting on a draft.

## 1. Sent-mail mining + review

1. **Settings → "Voice / style guide" → "Review mined style examples →"** opens `/voice/examples`.
2. Tap **Mine sent mail**. The button disables and a **"Mining N / M…"** line advances (driven by the
   `mining:progress` SSE event + `GET /style/mining-status`). The job processes your most recent ~200 sent
   messages one at a time.
3. When it finishes, the **Pending** tab fills with mined cards — each shows a category badge, style tags, a
   context summary, and the sent reply text.
4. **Approve** a card you like → it moves out of Pending (check the **Approved** tab). **Reject** one → it
   moves to **Rejected** (and a re-run won't resurface it). **Edit** → adjust the context/reply/tags →
   **Save**.
5. (Gateway up) Generate a draft on a thread whose contact category matches an **approved** example → the
   approved example is now eligible for the few-shot draft prompt (`sample()` returns only `approved`, read
   fresh per draft — no restart). Pending/rejected examples never shape a draft.
6. Re-run **Mine sent mail** → already-mined messages are skipped (the response reports `alreadyMined`); only
   new sent mail is enqueued.

## 2. Heavy-edit detection

Use the **`secretary test`** self-thread (don't email real third parties).

7. Generate a draft, then **materially rewrite** the body (replace most of it) and **send**.
8. Confirm a `draft_heavily_edited` row was logged with **ids + ratio only, no body text**:

```powershell
# from the service data dir; adjust the path/key to your setup
# (action_log details should contain threadId, version, divergencePct — and NO message text)
```

   Easiest check: tail the service's action log / DB `action_log` table and confirm a `draft_heavily_edited`
   entry exists with a numeric `divergencePct` and no body content. A **light** edit (a word or two) on another
   send should log **nothing**.

## 3. Phase 6a UI spot-check (deferred from 6a)

9. **Settings → "Voice / style guide"**: edit the guide (e.g. add _"Always sign off as 'Best, David'."_) →
   **Save** → generate a draft → the change is reflected (read fresh per draft). **Reset to default**
   repopulates the baseline + shows "(using default)".
10. **Contacts → tap a contact → ContactDetail**: set **Style notes** (e.g. _"Very casual; first-name
    basis."_) → **Save** → re-open to confirm it persists as plain text → generate a draft for that contact's
    thread → the style notes shape the reply.

## Acceptance (BRIEF §14 Phase 6, the 6b subset)

- Sent-mail mining populates `style_examples` with reasonable **pending** entries; approving one makes it feed
  drafts immediately; reject/edit behave. ✅ (steps 1–6)
- Sending a materially-edited draft logs `draft_heavily_edited` (ids + ratio only). ✅ (steps 7–8)
- (6a, re-confirmed live) Style-guide edits affect future drafts; per-contact style notes appear in that
  contact's draft prompt. ✅ (steps 9–10)

> Out of scope (later/optional): 6c sqlite-vec embedding retrieval; surfacing heavy-edit analytics in the UI.
