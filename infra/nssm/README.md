# NSSM service installer

Installs the gateway (`apps/gateway`) as the Windows service `secretary-gateway`.

## Prerequisites

- Node 20+ on `PATH`
- [NSSM](https://nssm.cc) on `PATH` (`choco install nssm`)
- The gateway has been built: `pnpm --filter @secretary/gateway build`
- 64-char hex API key and 64-char hex payload encryption key. Generate with:

  ```bash
  openssl rand -hex 32
  ```

## Install

Run from an **elevated** PowerShell prompt:

```powershell
.\install-gateway.ps1 `
  -RepoRoot C:\Users\drice\secretary `
  -GatewayApiKey <hex> `
  -PayloadEncryptionKey <hex>
```

Other parameters (port, host, model, log dir) have sensible defaults — see
`install-gateway.ps1`'s comment-based help (`Get-Help .\install-gateway.ps1 -Full`).

## Verify

```powershell
curl http://127.0.0.1:47823/health
```

Expected:

```json
{ "ok": true, "model_loaded": "qwen2.5:14b-instruct-q5_K_M" }
```

Logs go to `%USERPROFILE%\secretary-gateway\logs\stdout.log` and `stderr.log`.

## Uninstall

```powershell
.\uninstall-gateway.ps1
```
