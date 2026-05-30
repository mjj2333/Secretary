# Secretary

A locally-run AI email assistant.

Two machines, one principal:

- **Operator machine** runs Ollama and a lightweight gateway. The gateway is exposed via Cloudflare Tunnel and protected by Cloudflare Access + an API key + AES-256-GCM payload encryption. It never persists prompt or response content.
- **Principal machine** runs an Electron tray service (no desktop window) that watches the principal's mailboxes, classifies threads, drafts replies in her voice using the operator's LLM, and serves a mobile-first PWA used primarily from her phone.

Email content lives only on the principal's encrypted local database. LLM traffic that crosses to the operator is end-to-end encrypted at the application layer.

See `BRIEF.md` for the authoritative spec: stack, repo layout, security model, DB schema, API contracts, and phase plan with acceptance criteria.

## Repo layout

```
apps/
  gateway/    # Operator-side LLM gateway (Fastify + Ollama)
  service/    # Principal-side tray service + PWA (Electron tray + Fastify + React)
packages/
  shared-types/    # DTOs and domain types shared across apps
  shared-crypto/   # AES-256-GCM wrap/unwrap shared by gateway and service
  llm-protocol/    # Request/response envelope schemas for gateway traffic
infra/
  cloudflared/     # Tunnel config templates
  nssm/            # Windows service install scripts for the gateway
  mkcert/          # Local HTTPS cert generation for the principal service
docs/
  ARCHITECTURE.md, ONBOARDING-OPERATOR.md, ONBOARDING-PRINCIPAL.md, PROMPTS.md, THREAT-MODEL.md
```

## Development

Requirements:

- Node 20 LTS or newer
- pnpm 9 or newer (provisioned via the `packageManager` field; `corepack enable` recommended)

```bash
pnpm install
pnpm -r typecheck
pnpm lint
pnpm format
```

Phase status and per-phase acceptance criteria live in `BRIEF.md` §14.
