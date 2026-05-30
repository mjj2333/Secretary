# Generates locally-trusted HTTPS certs for the principal service (Windows dev).
# Requires mkcert: https://github.com/FiloSottile/mkcert  (install via: choco install mkcert)
param(
  [string]$OutDir = "$env:USERPROFILE\.secretary\certs"
)

if (-not (Get-Command mkcert -ErrorAction SilentlyContinue)) {
  Write-Error "mkcert not found. Install it (e.g. 'choco install mkcert') and re-run."
  exit 1
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
mkcert -install
mkcert -cert-file "$OutDir\localhost.pem" -key-file "$OutDir\localhost-key.pem" localhost 127.0.0.1 ::1

Write-Host "Certificates written to $OutDir"
Write-Host "  cert: $OutDir\localhost.pem"
Write-Host "  key:  $OutDir\localhost-key.pem"
