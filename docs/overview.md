# Overview

## What this repository is

The `base/` package (`bionic-platform` in `package.json`) is the **control plane** for the Bionic AI Platform:

- **Multi-tenant “apps”** (each app has a slug, LiveKit URL, enabled services, provisioning status).
- **Agent configuration** (STT/LLM/TTS providers, prompts, Letta linkage, tools, MCP servers, crews).
- **Provisioning orchestration** (Keycloak clients, Postgres DB, Redis prefix, MinIO bucket, Langfuse, Letta, Dify keys, K8s namespace, optional player-ui).
- **Operator UI** (React + Vite) for apps, agents, playground, settings.
- **Dify integration** (shared Dify instance proxied under `/dify/*`, optional auto-login flow).
- **Embeds** (public token-based access to a single deployed agent via LiveKit).

## Primary personas

1. **Platform admin** — Keycloak realm role `Admin` maps to coarse `role: "admin"`; can create apps, see all apps, run privileged flows.
2. **App member** — Row in `app_members` for `(appId, userId)` where `userId` is Keycloak `sub`. Owners can update app metadata; members are scoped by procedures.
3. **Analyst** — Realm roles `Analyst` / `Admin` (case-insensitive) used by `analystOrAdminProcedure` for crew-template workflows.
4. **Anonymous embed visitor** — Uses a long-lived **embed token** (DB row) plus public `/api/embed/*` routes; optional per-token `allowedOrigins`.

## Technology stack

| Layer | Technology |
|-------|------------|
| UI | React 19, Vite 6, Tailwind 4, Wouter, TanStack Query, Radix UI |
| API | Express 4, tRPC 11, SuperJSON |
| Auth | Keycloak OIDC, `jose` (JWT sign/verify for session cookie) |
| DB | PostgreSQL, Drizzle ORM |
| Infra automation | `@kubernetes/client-node`, Vault HTTP client |
| Voice / realtime | LiveKit server SDK (token minting) |
| Agent runtime (separate image) | Python template under `agent-template/` |

## Out of scope (but integrated)

GPU inference services, MCP API gateway, and cluster networking are **external**; the platform configures agents to call them via environment variables and Vault secrets (`server/services/agentDeployer.ts`).
