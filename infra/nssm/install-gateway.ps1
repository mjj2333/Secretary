<#
.SYNOPSIS
Install the Secretary gateway as a Windows service via NSSM.

.DESCRIPTION
Idempotently (re)installs the secretary-gateway Windows service. The service runs
`node <repo>/apps/gateway/dist/index.js` with the supplied secrets in its environment.
Logs go to AppStdout/AppStderr files in -LogDir with rotation at 10 MiB.

.PARAMETER RepoRoot
Absolute path to the secretary monorepo root.

.PARAMETER GatewayApiKey
64-char hex string used as the X-API-Key value. Generate with `openssl rand -hex 32`.

.PARAMETER PayloadEncryptionKey
64-char hex string used for AES-256-GCM payload encryption. Generate with `openssl rand -hex 32`.

.PARAMETER ServiceName
Name of the Windows service to create. Default: secretary-gateway.

.PARAMETER NssmExe
Path or command for nssm.exe. Default: 'nssm' (must be on PATH).

.PARAMETER NodeExe
Path to node.exe. Default: resolved via Get-Command.

.PARAMETER Port
TCP port the gateway listens on. Default: 47823.

.PARAMETER Host
Bind address. Default: 127.0.0.1 (gateway is expected to be fronted by cloudflared).

.PARAMETER OllamaUrl
URL of the local Ollama server. Default: http://localhost:11434.

.PARAMETER OllamaDefaultModel
Default model name (passed back in /health). Default: qwen2.5:14b-instruct-q5_K_M.

.PARAMETER OllamaKeepAlive
Ollama keep_alive value. Default: 0 (unload after each request to free VRAM).

.PARAMETER LogLevel
Pino log level. Default: info.

.PARAMETER LogDir
Directory for stdout/stderr logs. Default: $env:USERPROFILE\secretary-gateway\logs.

.EXAMPLE
.\install-gateway.ps1 `
  -RepoRoot C:\Users\drice\secretary `
  -GatewayApiKey (openssl rand -hex 32) `
  -PayloadEncryptionKey (openssl rand -hex 32)
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$RepoRoot,
  [Parameter(Mandatory = $true)][string]$GatewayApiKey,
  [Parameter(Mandatory = $true)][string]$PayloadEncryptionKey,
  [string]$ServiceName = 'secretary-gateway',
  [string]$NssmExe = 'nssm',
  [string]$NodeExe,
  [int]$Port = 47823,
  [string]$BindHost = '127.0.0.1',
  [string]$OllamaUrl = 'http://localhost:11434',
  [string]$OllamaDefaultModel = 'qwen2.5:14b-instruct-q5_K_M',
  [string]$OllamaKeepAlive = '0',
  [string]$LogLevel = 'info',
  [string]$LogDir = "$env:USERPROFILE\secretary-gateway\logs"
)

$ErrorActionPreference = 'Stop'

if ($GatewayApiKey -notmatch '^[0-9a-fA-F]{64}$') {
  throw "GatewayApiKey must be 64 hex characters."
}
if ($PayloadEncryptionKey -notmatch '^[0-9a-fA-F]{64}$') {
  throw "PayloadEncryptionKey must be 64 hex characters."
}

if (-not $NodeExe) {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { throw "node.exe not found on PATH. Pass -NodeExe explicitly." }
  $NodeExe = $node.Path
}

$entryScript = Join-Path $RepoRoot 'apps\gateway\dist\index.js'
if (-not (Test-Path $entryScript)) {
  throw "Gateway build not found at $entryScript. Run 'pnpm --filter @secretary/gateway build' first."
}

$workingDir = Join-Path $RepoRoot 'apps\gateway'

if (-not (Test-Path $LogDir)) {
  New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

Write-Host "Removing any prior install of '$ServiceName'..."
& $NssmExe stop $ServiceName 2>$null | Out-Null
& $NssmExe remove $ServiceName confirm 2>$null | Out-Null

Write-Host "Installing service '$ServiceName'..."
& $NssmExe install $ServiceName $NodeExe $entryScript
if ($LASTEXITCODE -ne 0) { throw "nssm install failed (exit $LASTEXITCODE)" }

& $NssmExe set $ServiceName AppDirectory $workingDir | Out-Null
& $NssmExe set $ServiceName DisplayName 'Secretary LLM Gateway' | Out-Null
& $NssmExe set $ServiceName Description 'Encrypted gateway from the principal service to the operator-side Ollama LLM.' | Out-Null
& $NssmExe set $ServiceName Start SERVICE_AUTO_START | Out-Null
& $NssmExe set $ServiceName AppStdout (Join-Path $LogDir 'stdout.log') | Out-Null
& $NssmExe set $ServiceName AppStderr (Join-Path $LogDir 'stderr.log') | Out-Null
& $NssmExe set $ServiceName AppRotateFiles 1 | Out-Null
& $NssmExe set $ServiceName AppRotateOnline 1 | Out-Null
& $NssmExe set $ServiceName AppRotateBytes 10485760 | Out-Null

$envLines = @(
  "PORT=$Port",
  "HOST=$BindHost",
  "GATEWAY_API_KEY=$GatewayApiKey",
  "PAYLOAD_ENCRYPTION_KEY=$PayloadEncryptionKey",
  "OLLAMA_URL=$OllamaUrl",
  "OLLAMA_DEFAULT_MODEL=$OllamaDefaultModel",
  "OLLAMA_KEEP_ALIVE=$OllamaKeepAlive",
  "LOG_LEVEL=$LogLevel",
  "NODE_ENV=production"
)
$envBlock = $envLines -join [Environment]::NewLine
& $NssmExe set $ServiceName AppEnvironmentExtra $envBlock | Out-Null

Write-Host "Starting '$ServiceName'..."
& $NssmExe start $ServiceName
if ($LASTEXITCODE -ne 0) { throw "nssm start failed (exit $LASTEXITCODE). Check $LogDir\stderr.log." }

Write-Host ""
Write-Host "Service '$ServiceName' is running."
Write-Host "  Logs:         $LogDir"
Write-Host "  Local health: curl http://${BindHost}:${Port}/health"
