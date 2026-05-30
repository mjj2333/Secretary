# mkcert — local HTTPS certificates for the principal service

The principal service serves its PWA + API over HTTPS using a locally-trusted
certificate. In dev we generate that cert with [mkcert](https://github.com/FiloSottile/mkcert).

## Windows

1. Install mkcert: `choco install mkcert` (or download the release binary).
2. From the repo root run: `pwsh infra/mkcert/setup-certs.ps1`
3. This runs `mkcert -install` (adds the local CA to your OS trust store) and writes
   `localhost.pem` + `localhost-key.pem` to `%USERPROFILE%\.secretary\certs`, which is
   where `apps/service` looks by default. Override with `SERVICE_CERT_PATH` /
   `SERVICE_KEY_PATH` env vars.

## macOS (later)

A `setup-certs.sh` equivalent will be added when the service is packaged for macOS.
The service itself is platform-agnostic — only this cert-generation helper differs.
