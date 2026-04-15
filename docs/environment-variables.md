# Environment variables (reference)

This list is **non-exhaustive**. For the full set, search for `process.env` under `server/` and `client/`.

## Core platform

| Variable | Purpose |
|----------|---------|
| `PORT` | Express listen port (default `3000`) |
| `NODE_ENV` | `production` vs development behavior (CORS, cookies, player-ui token enforcement) |
| `DATABASE_URL` | PostgreSQL connection string for Drizzle |

## Authentication and session

| Variable | Purpose |
|----------|---------|
| `KEYCLOAK_URL` | Public OIDC issuer base URL |
| `KEYCLOAK_REALM` | Realm name |
| `KEYCLOAK_CLIENT_ID` | OIDC client id |
| `KEYCLOAK_CLIENT_SECRET` | OIDC client secret (token exchange) |
| `KEYCLOAK_REDIRECT_URI` | OAuth redirect URI registered in Keycloak |
| `SESSION_SECRET` | HMAC key for signing `bp_session` (required in production) |
| `KEYCLOAK_INTERNAL_URL` | Base URL for admin REST calls (`keycloakAdmin.ts`) |
| `KEYCLOAK_ADMIN_USER` | Master realm admin username |
| `KEYCLOAK_ADMIN_PASSWORD` | Master realm admin password |

## Vault

| Variable | Purpose |
|----------|---------|
| `VAULT_ADDR` | Vault API base URL |
| `VAULT_TOKEN` | Vault token with policies for app and platform paths |

## Letta

| Variable | Purpose |
|----------|---------|
| `LETTA_BASE_URL` | Letta HTTP API base |
| `LETTA_API_KEY` | Optional bearer token for Letta admin API |
| `DIFY_INTERNAL_URL` | Internal Dify API URL used in Letta tooling (`lettaAdmin.ts`) |

## LiveKit, player-ui, agents

| Variable | Purpose |
|----------|---------|
| `LIVEKIT_INTERNAL_URL` | WebSocket URL stored during provisioning |
| `PLAYER_UI_INTERNAL_TOKEN` | Validates `X-Internal-Token` on `/api/player-ui/agents` |
| `AGENT_TEMPLATE_IMAGE` | Container image for deployed agent workers |
| `WEBHOOK_BASE_URL` | Base URL for LiveKit webhook registration |
| `MINIO_ENDPOINT` | Host:port for MinIO |
| `MINIO_USE_SSL` | `"true"` when using TLS to MinIO |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | Credentials used by document upload path in `server/index.ts` |

## GPU and internal MCP (agent pod)

| Variable | Purpose |
|----------|---------|
| `GPU_AI_MCP_INTERNAL_URL` | MCP URL for GPU tools |
| `GPU_AI_LLM_INTERNAL_URL` | OpenAI-compatible LLM base URL inside cluster |
| `LETTA_INTERNAL_URL` | Optional override for Letta MCP URL in deployer |

## Dify

| Variable | Purpose |
|----------|---------|
| `DIFY_ADMIN_EMAIL` | Account used by `/dify-login` |
| `DIFY_ADMIN_PASSWORD` | Password for that account |
| `DIFY_EXTERNAL_BASE_URL` | Public Dify base URL for redirects |

## Search MCP

| Variable | Purpose |
|----------|---------|
| `SEARCH_MCP_BASE_URL` | Remote search MCP HTTP base |
| `SEARCH_MCP_API_KEY` | Fallback API key when Vault is not used |

## Notifications

| Variable | Purpose |
|----------|---------|
| `NOTIFY_WEBHOOK_TOKEN` | Expected `X-Bionic-Token` header value for `/api/webhooks/notify` |

## Kubernetes and NFS

| Variable | Purpose |
|----------|---------|
| `KUBECONFIG` | Path to kubeconfig for out-of-cluster API use |
| `K8S_LIVEKIT_NAMESPACE` | Namespace containing LiveKit ExternalSecret |
| `LIVEKIT_KEYS_SECRET_NAME` | Kubernetes secret name for LiveKit keys |
| `MODEL_CACHE_NFS_SERVER` | NFS server for shared model cache on agent pods |
| `MODEL_CACHE_NFS_PATH` | NFS export path |

## Cloudflare and player-ui DNS

| Variable | Purpose |
|----------|---------|
| `PLAYER_UI_SKIP_CLOUDFLARE_DNS` | When `"true"`, skips Cloudflare automation in provisioning |
