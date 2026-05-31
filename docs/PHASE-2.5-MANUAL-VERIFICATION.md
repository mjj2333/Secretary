# Phase 2.5 (foundation) — Manual Verification (PWA)

Automated tests cover the plumbing (apiFetch, session, SSE mapping, the two server changes, the
nav). The UI + serving are verified here. Run PowerShell from `C:\Users\drice\Secretary`. Prereqs
as in Phase 4/5: the service on the **Node ABI** SQLite build (so `dev:server` runs), HTTPS certs in
place; the operator gateway + Ollama up if you want live classification/drafts to populate the lists.

## 1. Dev loop (Vite + service)

Terminal A — the service (HTTPS API on 47824):

```powershell
$env:LOG_PRETTY = 'true'
pnpm --filter @secretary/service dev:server
```

Terminal B — the PWA dev server (HMR on 5173, proxying `/api/v1` + SSE to the service):

```powershell
pnpm --filter @secretary/pwa dev
```

Open **http://localhost:5173** in a browser.

## 2. Auth handshake

The app shows "Connect Secretary". Get the bootstrap token:

```powershell
Get-Content "$env:USERPROFILE\.secretary\bootstrap-token.txt" -Raw
```

Paste it into the field → **Connect**. You should land on **/needs-attention**.

- (Alternative: open `http://localhost:5173/#bootstrap=<token>` directly — the hash is exchanged
  automatically and then stripped from the URL.)

## 3. Shell + data path

- The bottom nav shows 5 items; tapping each routes (Attention / Follow-ups / Inbox / Contacts / Settings).
- **Needs Attention** lists the classified `awaiting_your_reply` threads (from the real API); tapping a
  row opens **/threads/:id** showing the messages (direction, sender, snippet/body).
- **Inbox** lists threads; **Contacts** lists contacts; **Settings** dumps the settings JSON.
- **Follow-ups** is an intentional placeholder ("coming in the next phase").
- Empty/loading/error states render when the API has no data or the gateway is down.

## 4. Live updates (SSE)

With the app open on Needs Attention, trigger a change from a second terminal — e.g. re-classify a
thread (`POST /api/v1/threads/:id/classify`) or send a draft via the Phase-5 flow. Within a moment the
list should refresh **without a manual reload** (the SSE stream invalidates the query). In browser
devtools → Network, confirm the `/api/v1/events?token=…` EventStream stays open, and that it
**auto-reconnects** if you restart the service (Terminal A).

## 5. Production serve + service worker

```powershell
pnpm --filter @secretary/pwa build
```

Restart the service so it serves `pwa/dist`, then open **https://localhost:47824** directly (no Vite).

- The SPA loads and works (same flow as above), served by Fastify.
- A client route like `https://localhost:47824/contacts` loads directly (the SPA fallback returns
  index.html and the client router renders Contacts).
- DevTools → Application → Service Workers shows the Workbox SW registered. Reload with DevTools →
  Network → **Offline**: the app **shell** still loads (data calls fail gracefully — runtime caching of
  API responses is Phase 5.5, so lists show their error/empty state offline).

## Acceptance (BRIEF §14 Phase 2.5, foundation subset)

- Vite+React+TS+Tailwind app builds; manifest + SW generated. ✅ (step 5)
- Bottom nav + (placeholder) routes; default route /needs-attention. ✅ (steps 2–3)
- API client + bootstrap→session auth works end to end. ✅ (steps 2–3)
- SSE connection management with auto-reconnect drives live updates. ✅ (step 4)
- Fastify serves the built SPA with an SPA fallback. ✅ (step 5)

> The **setup wizard** (BRIEF §14 Phase 2.5 step 4) and the **designed screens** are deferred to a
> follow-on phase; this runbook verifies the foundation only.
