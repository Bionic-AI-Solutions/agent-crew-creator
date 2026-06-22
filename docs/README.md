# Bionic Platform (`base/`) — Documentation

This folder documents the **Bionic Platform** monorepo under `base/`: a TypeScript/React admin UI and Express/tRPC API for multi-tenant apps, agent configuration, Dify crew workflows, LiveKit playground/embed, Vault-backed secrets, and Kubernetes provisioning.

## Document map

| Document | Purpose |
|----------|---------|
| [overview.md](./overview.md) | Product scope, personas, tech stack |
| [architecture.md](./architecture.md) | Runtime architecture, request flows, dependencies |
| [repository-structure.md](./repository-structure.md) | Directory layout and key modules |
| [authentication-and-authorization.md](./authentication-and-authorization.md) | Keycloak OIDC, session cookie, tRPC procedures |
| [http-and-express-routes.md](./http-and-express-routes.md) | Non-tRPC HTTP routes, proxies, webhooks |
| [trpc-routers.md](./trpc-routers.md) | tRPC router map and procedure types |
| [database-and-migrations.md](./database-and-migrations.md) | Drizzle schema, main tables |
| [provisioning-and-deployment.md](./provisioning-and-deployment.md) | App provisioning, K8s, agent deploy |
| [integrations.md](./integrations.md) | Dify, Letta, LiveKit, MinIO, Vault, Search MCP, etc. |
| [embed-and-playground.md](./embed-and-playground.md) | Public embed, Playground, LiveKit tokens |
| [agent-runtime-template.md](./agent-runtime-template.md) | Python agent image template in `agent-template/` |
| [security-and-operations.md](./security-and-operations.md) | Threat notes, operational checklist |
| [development.md](./development.md) | Local dev, build, scripts |
| [environment-variables.md](./environment-variables.md) | Environment variable reference |
| [testing.md](./testing.md) | Unit tests, E2E scripts |

## Canonical product README

The original high-level product description lives at the repo root: [`../README.md`](../README.md) (“Agent Crew Creator”).
