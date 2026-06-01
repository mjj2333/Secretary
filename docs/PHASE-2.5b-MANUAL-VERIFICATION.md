# PWA Designed Screens — Manual Verification

Automated tests cover the server enrichments (`app.inject`) and the pure client bits
(`formatTimeAgo`, `DiffView`, `NeedsAttentionCard`, `DraftPanel`). The screens are verified here.
PowerShell from `C:\Users\drice\Secretary`. Prereqs: the service on the Node-ABI build; the operator
gateway + Ollama **up** (drafting calls the live LLM).

## Setup

```powershell
# Terminal A — service (HTTPS API on 47824)
pnpm --filter @secretary/service dev:server
# Terminal B — PWA dev server (proxies /api/v1 + SSE)
pnpm --filter @secretary/pwa dev
```

Open http://localhost:5173, connect with the bootstrap token
(`Get-Content "$env:USERPROFILE\.secretary\bootstrap-token.txt" -Raw`).

## Needs Attention

- Cards show **sender name**, time-ago, urgency pill, subject, agent summary.
- A thread with a draft shows **"Review draft ▸"**; one without shows **"Generate draft"**.
- Tap **Generate draft** on a card → it shows "Generating…" then routes into the thread with the new
  draft (the gateway must be up).
- Tapping a card body opens the thread.

## Thread / draft review

- Conversation renders; the latest inbound message is expanded, others collapse/expand on tap.
- The draft editor shows the body (editable) + version label + the intent line.
- **Diff**: tap "diff" → shows the polish diff (added green / removed red); it's greyed when the draft
  had no raw intent.
- **Edit intent**: tap "Edit intent" → type an intent → "Regenerate" → a new version replaces the body.
- **Regenerate**: makes a new version from the last intent.
- **Edit + Send**: change the textarea, tap **Send** → the confirm sheet appears → confirm → the edited
  text is what sends; you return to Needs Attention and the card is gone (thread → awaiting_their_reply).
- **Send failure** (stop the gateway/provider, or use a disconnected account): error banner, the draft
  stays (badge shows "send failed"), thread unchanged — re-sendable.
- **Discard**: removes the draft → the screen returns to the "Generate draft" state.

## Live (SSE)

- With Needs Attention open, generate/regenerate/send from the thread screen → the list updates without
  a manual reload (the card's draft state / ordering refresh via SSE invalidation).

## Production serve (optional)

- `pnpm --filter @secretary/pwa build`; run the compiled server (`node apps/service/dist/server/index.js`);
  open https://localhost:47824 and repeat the core flow (different origin → reconnect with a fresh
  bootstrap token).

## Acceptance

- Cards (sender-led, draft affordance) ✅; thread/draft review with
  generate/regenerate/edit/diff/send-confirm/discard ✅; live SSE refresh ✅.
