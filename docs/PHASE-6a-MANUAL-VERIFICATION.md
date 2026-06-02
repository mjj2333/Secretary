# Phase 6a — Manual Verification (Voice Editing)

Server logic is unit-tested (`resolveVoiceGuide`, `GET /settings/style-guide`, the `styleNotes` round-trip).
The two editor screens are verified here. PowerShell from `C:\Users\drice\Secretary`. Prereqs: the service
running; the operator gateway + Ollama up if you want to confirm a voice change actually shapes a generated
draft (see the memory note on starting the gateway from the keychain).

## Setup (dev loop)

```powershell
pnpm --filter @secretary/service dev:server
pnpm --filter @secretary/pwa dev
```

Open http://localhost:5173, connect with the bootstrap token.

## Style-guide editor

1. **Settings tab → "Voice / style guide"** — shows the current guide; with no override the heading reads
   **"(using default)"** and the textarea is pre-filled with the baseline.
2. Edit the text (e.g. add a line: _"Always sign off as 'Best, David'."_) → **Save** → "Saved." (The heading
   drops "(using default)".)
3. (Gateway up) generate a draft on a thread → the change is reflected — the guide is read fresh per draft
   (`PromptAssembler.voiceGuide()` → `resolveVoiceGuide`), so no restart is needed.
4. **Reset to default** → the textarea repopulates with the baseline and the heading shows "(using default)".

## Per-contact editor

5. **Contacts tab** → tap a contact → **ContactDetail** opens at `/contacts/:id`, pre-filled with category /
   notes / style notes / do-not-auto-draft + the in/out message stats.
6. Set **Style notes** (e.g. _"Very casual; first-name basis."_) and/or change the **category** → **Save** →
   "Saved." Re-open the contact → the saved values persist (and the style notes display as plain text, not
   JSON-quoted).
7. (Gateway up) generate a draft for that contact's thread → the style notes appear in the draft prompt and
   shape the reply.

## Acceptance (6a subset of BRIEF §14 Phase 6)

- Editing the style guide affects future drafts immediately. ✅ (steps 2–3)
- Per-contact style notes appear in that contact's draft prompt. ✅ (steps 6–7)

> Deferred to 6b: "heavily edited" detection (item 5), sent-mail mining + review (item 3). Optional 6c:
> sqlite-vec embedding retrieval (item 6).
