# Phase 5.5 — Manual Verification (Web Push + Offline)

Logic is unit-tested (quiet hours, the `WebPushSender`, the push routes, `urlBase64ToUint8Array`,
`useOnlineStatus`). The push round-trip, the service worker, and the offline UX are verified here on the
**desktop browser** (Chrome or Firefox — both support Web Push). PowerShell from
`C:\Users\drice\Secretary`. Prereqs: service on the Node-ABI build; operator gateway + Ollama up
(drafting needs the LLM — see the memory note on starting the gateway from the keychain).

## Why the compiled server

The service worker only exists in the **build** (`devOptions.enabled:false`), and VAPID keys are
generated/served by the running service. So push + offline are verified against the **compiled server**
on `:47824`, not the Vite dev server.

```powershell
pnpm --filter @secretary/pwa build        # produces dist/sw.js
node apps\service\dist\server\index.js     # serves the built SW + generates/serves VAPID on first run
```

Open **https://localhost:47824**, connect with the bootstrap token
(`Get-Content "$env:USERPROFILE\.secretary\bootstrap-token.txt" -Raw`).

## Web Push

1. **Settings → Enable notifications** → grant permission → "Notifications enabled."
   (`GET /push/vapid-public-key` → `pushManager.subscribe` → `POST /push/subscribe`.)
2. **Settings → Send test** → a "Secretary test" notification appears; clicking it focuses/opens the app.
3. **Real draft** (the §5.5 acceptance): open a thread → Generate a draft (gateway up). Within ~seconds a
   **"New draft ready for <sender>"** notification appears; **clicking it opens `/threads/:id`**. ✅
4. **Quiet hours**: set `notifications.quiet_hours_start`/`_end` to span "now" (e.g. PATCH `/settings`, or
   edit the settings), regenerate a draft → **no** notification, but the draft still appears in the app
   (SSE). Reset quiet hours afterward.

## Offline

5. **Send-queue**: open the `secretary test` self-thread with a draft (to avoid emailing a real party).
   DevTools → Network → **Offline**. Tap **Send** → the UI shows **"Queued — will send when you're back
   online"** and returns to Needs Attention. Toggle back **online** → the SW's BackgroundSync replays
   `POST /drafts/:id/send` → the email is sent (thread flips / the message arrives).
6. **Offline banner**: with DevTools Offline on, the **"Offline — last synced X ago"** banner shows under
   the header; toggling back online hides it.

## Acceptance

- New draft → Web Push within ~30s → tap opens the thread. ✅ (step 3)
- Quiet hours suppress push only (draft + SSE unaffected). ✅ (step 4)
- Offline send queues + replays on reconnect; offline banner with last-synced time. ✅ (steps 5–6)

> Note: per the deferred item D, there is no runtime API caching — offline shows the precached app shell +
> the banner, not cached thread/draft data. The phone is the eventual target (needs the trusted-HTTPS
> tunnel); the push mechanism is proven on the desktop here.

## Offline-queue testing caveat (verified 2026-06-02)

The offline send-queue is **functionally verified** — tapping Send while offline queues the request and it
**replays on reconnect** (the email sends). Two caveats for _testing the UX_:

- **Use a Chromium browser (Chrome/Edge) with DevTools → Network → "Offline"** to verify the **"Queued"
  toast**. The Background Sync API is Chromium-only, and Chromium's DevTools "Offline" cleanly flips
  `navigator.onLine` _and_ fails the fetch. On Firefox the request still delivers on reconnect, but the
  toast timing is unreliable to observe.
- **Firefox "File → Work Offline" is not a reliable offline simulation for a localhost service** — loopback
  requests to `localhost:47824` may still go through, so the send can succeed instead of queueing.
- After rebuilding, **hard-reload twice** (or DevTools → Application → Service Workers → Update) so the new
  injectManifest SW + bundle actually take over before testing — the shell is precached.
