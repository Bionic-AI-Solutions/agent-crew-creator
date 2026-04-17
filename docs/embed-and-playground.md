# Embed and Playground

## Playground (authenticated)

**Router**: `server/playgroundRouter.ts`

- **`playground.getMeta`** — `appScopedProcedure`. Reads Vault for the app slug and returns whether LiveKit credentials exist, plus non-secret metadata such as public LiveKit URL and Langfuse project id when present.
- **`playground.getConnectionBundle`** — `appScopedProcedure`. Mints a LiveKit access token:
  - **Identity** = Keycloak `sub` (required for per-user memory in the worker).
  - **Room name** unique per session (`pg-${slug}-${agentId}-${userTag}-${rand}`).
  - **`RoomConfiguration`** dispatches the worker with `agentName = `${app.slug}-${agent.name}`` to match `AGENT_NAME` from `agentDeployer`.

## Public embed (unauthenticated)

**Module**: `server/embedPublicRoutes.ts` — registered **before** global CORS in `server/index.ts` so embed routes can use their own CORS policy (`origin: true`, `credentials: false`).

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| OPTIONS | `/api/embed/*` | CORS preflight |
| POST | `/api/embed/connection-details` | Validate embed token, optional origin allowlist, rate limit, mint LiveKit visitor JWT |
| GET | `/api/s3-proxy/:bucket/*` | Proxy presigned MinIO URLs; only `image/*` responses |
| GET | `/api/embed/widget.js` | Serve built embed bundle (`dist/public/embed-popup.js`) |
| GET | `/embed/:embedToken` | Minimal HTML page bootstrapping embed config |

### Embed token administration

**Router**: `server/embedRouter.ts` (tRPC namespace `embed`)

- List, create, update, revoke tokens tied to `agent_configs`.
- Token value: 64 hex characters from `randomBytes(32)`.

## Operational notes

- Application rate limiting for embed is **in-memory** in `embedPublicRoutes.ts` — supplement with ingress or API gateway limits in multi-replica deployments.
- Review `frame-ancestors` and s3-proxy behavior whenever changing embed or MinIO exposure.
