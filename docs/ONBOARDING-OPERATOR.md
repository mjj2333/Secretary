# Operator onboarding

This is the runbook for the **operator** — the person whose GPU machine runs Ollama and the Secretary gateway. Total wall time on a fresh Windows install: ~30 minutes, plus model download (10–40 minutes depending on bandwidth).

The gateway is a small Node service that:

1. Listens on `127.0.0.1:47823` (default).
2. Validates an `X-API-Key` header.
3. Decrypts an AES-256-GCM payload from the principal's service.
4. Forwards the prompt to local Ollama.
5. Encrypts the response and returns it.

It is fronted by Cloudflare Access (Service Token) via Cloudflare Tunnel. The operator never sees email content in plaintext.

---

## 1. Prerequisites

- Windows 10/11 with administrative access
- A Cloudflare account and a domain registered there (e.g. `example.com`)
- ~50 GB free disk for the default model (`qwen2.5:14b-instruct-q5_K_M`, ~10 GB) plus space for VRAM swap
- Node 20 LTS or newer
- pnpm 9+ (`npm install -g pnpm` or `corepack enable pnpm` if you have admin)
- [NSSM](https://nssm.cc/download) on `PATH` (`choco install nssm`)
- `openssl` available (Git Bash, WSL, or `choco install openssl.light`)

## 2. Install and configure Ollama

1. Download and run the [Ollama for Windows installer](https://ollama.com/download/windows). It installs Ollama as a background service that auto-starts on login.
2. Pull the default model:

   ```bash
   ollama pull qwen2.5:14b-instruct-q5_K_M
   ```

3. Verify:

   ```bash
   curl http://localhost:11434/api/tags
   ```

   You should see `qwen2.5:14b-instruct-q5_K_M` in the list.

> **VRAM note**: the gateway calls Ollama with `keep_alive=0` so the model unloads after each request. This frees VRAM for ComfyUI and other workloads, but adds ~1–2 seconds of load time per request. If you'd rather keep the model resident, set `OLLAMA_KEEP_ALIVE` (see §6).

## 3. Clone and build the gateway

```bash
cd %USERPROFILE%
git clone <repo-url> secretary
cd secretary
pnpm install
pnpm --filter @secretary/gateway build
```

## 4. Generate the two secrets

You need two independent 64-char hex strings. Save them somewhere safe — you'll need both on the principal's machine too.

```bash
openssl rand -hex 32   # GATEWAY_API_KEY
openssl rand -hex 32   # PAYLOAD_ENCRYPTION_KEY
```

Treat both as production secrets: password manager, not chat or email.

## 5. Set up Cloudflare Tunnel + Access

If you already have `cloudflared` running on this machine for other services, you only need to add a new ingress rule. From scratch:

1. Install `cloudflared`:

   ```powershell
   winget install --id Cloudflare.cloudflared
   ```

2. Authenticate (this opens a browser):

   ```bash
   cloudflared tunnel login
   ```

3. Create a tunnel:

   ```bash
   cloudflared tunnel create secretary-gateway
   ```

   Note the tunnel UUID. A credentials file is written to `%USERPROFILE%\.cloudflared\<UUID>.json`.

4. Route DNS for the public hostname:

   ```bash
   cloudflared tunnel route dns secretary-gateway llm.<your-domain>
   ```

5. Copy `infra/cloudflared/operator-tunnel.example.yml` to `%USERPROFILE%\.cloudflared\config.yml` and fill in the UUID, credentials path, and hostname.

6. Install `cloudflared` as a Windows service:

   ```bash
   cloudflared service install
   ```

7. In the Cloudflare dashboard:
   - Open **Zero Trust → Access → Applications → Add an application → Self-hosted**.
   - Application domain: `llm.<your-domain>`.
   - Add a **Service Auth** policy: **Action = Allow**, **Selector = Service Token = secretary-principal**.
   - Create the service token under **Access → Service Auth → Service Tokens → Create**. Copy the Client ID and Client Secret — you'll need both on the principal's machine.

## 6. Install the gateway as a Windows service

From an **elevated** PowerShell prompt:

```powershell
cd C:\Users\<you>\secretary\infra\nssm
.\install-gateway.ps1 `
  -RepoRoot C:\Users\<you>\secretary `
  -GatewayApiKey <hex from step 4> `
  -PayloadEncryptionKey <hex from step 4>
```

Optional parameters (defaults shown):

- `-Port 47823`
- `-BindHost 127.0.0.1`
- `-OllamaUrl http://localhost:11434`
- `-OllamaDefaultModel qwen2.5:14b-instruct-q5_K_M`
- `-OllamaKeepAlive 0` — set to `5m` (or similar) to keep the model resident between requests
- `-LogLevel info`
- `-LogDir $env:USERPROFILE\secretary-gateway\logs`

## 7. Verify locally

```powershell
curl http://127.0.0.1:47823/health
```

Expected: `{"ok":true,"model_loaded":"qwen2.5:14b-instruct-q5_K_M"}`

Logs:

```
%USERPROFILE%\secretary-gateway\logs\stdout.log
%USERPROFILE%\secretary-gateway\logs\stderr.log
```

The service is configured for `SERVICE_AUTO_START`, so it'll come back after reboot.

## 8. Verify end-to-end

From any machine with the secrets:

```bash
curl https://llm.<your-domain>/health \
  -H "CF-Access-Client-Id: <id>" \
  -H "CF-Access-Client-Secret: <secret>"
```

For a full encrypted round-trip, set these env vars and run the manual script (from a check-out of the monorepo):

```bash
export GATEWAY_URL=https://llm.<your-domain>
export GATEWAY_API_KEY=<hex>
export PAYLOAD_ENCRYPTION_KEY=<hex>
export CF_ACCESS_CLIENT_ID=<id>
export CF_ACCESS_CLIENT_SECRET=<secret>

pnpm --filter @secretary/gateway manual:round-trip "Say hi in five words."
```

You should see the model's reply printed.

## 9. Operations

- **Restart**: `nssm restart secretary-gateway` (PowerShell, elevated)
- **Stop**: `nssm stop secretary-gateway`
- **Uninstall**: `.\infra\nssm\uninstall-gateway.ps1` (elevated)
- **Update**: `git pull && pnpm install && pnpm --filter @secretary/gateway build && nssm restart secretary-gateway`
- **Rotate secrets**: re-run `install-gateway.ps1` with new `-GatewayApiKey` and/or `-PayloadEncryptionKey`. Don't forget to update the principal's machine.
- **Logs**: tail `stdout.log`. Logs are JSON (pino). Bodies, prompts, and completions are never logged — only metadata.

## 10. Troubleshooting

- `model_loaded: null` on `/health` — Ollama is unreachable. Check `ollama serve` is running and `OLLAMA_URL` matches.
- `unauthorized` on `/v1/complete` — `X-API-Key` doesn't match `GATEWAY_API_KEY`. Check casing (the gateway lowercases internally; both sides should use the same hex).
- `decryption_failed` — `PAYLOAD_ENCRYPTION_KEY` differs between operator and principal.
- `ollama_timeout` — increase `OLLAMA_TIMEOUT_MS` (default 180000) if you're using a very large model or cold-loading on slow disks.
- Cloudflare returns 403 with no body — Service Token isn't attached to the Access policy. Check the Access dashboard.
