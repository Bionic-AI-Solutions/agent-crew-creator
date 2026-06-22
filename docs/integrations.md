# External integrations

## Vault (HashiCorp KV v2)

- **Client**: `server/vaultClient.ts`
- **Per-app secrets**: `secret/data/t6-apps/<slug>/config`
- **Platform secrets**: `secret/data/platform/<name>` (for example `search-mcp`, `notify`)
- **Cross-app paths**: `readPlatformVaultPath("shared/...")` — used for LiveKit keys cluster config and other shared paths

## Keycloak

- **Admin REST API**: `server/services/keycloakAdmin.ts` — obtains a master-realm token via `admin-cli` password grant, then manages realm clients and roles.
- **Browser OIDC**: `server/_core/auth.ts` — authorization code flow for platform users.

## LiveKit

- Keys and URLs live in Vault per app.
- The platform mints **join tokens** with `RoomAgentDispatch` so workers auto-join new rooms (`server/playgroundRouter.ts`, `server/embedPublicRoutes.ts`).

## Letta

- **Admin API wrapper**: `server/services/lettaAdmin.ts` — `LETTA_BASE_URL`, optional `LETTA_API_KEY`.
- Used for agent lifecycle, archival passages, memory blocks, and tool sync from the platform side.

## Dify

- **Shared** Dify API and web run in-cluster; the platform reverse-proxies `/dify/*` and related paths (`server/index.ts`).
- **Admin patterns**: `server/services/difyAdmin.ts` — workflow execution, DSL import, console API calls.
- **Crews**: Installed and executed through `agentRouter` and supporting services (`crewInstaller`, `crewTemplateLoader`, etc.).

## MinIO

- **Admin**: `server/services/minioAdmin.ts` — buckets and service accounts during provisioning.
- **Document upload path**: `server/index.ts` uses the `minio` npm package with `MINIO_ENDPOINT` and root credentials for `putObject` into the app bucket. Prefer least-privilege credentials in production.

## Email and PDF

- `server/services/mailer.ts` — SMTP (for example Gmail relay).
- `server/services/pdfReport.ts` — PDF generation for notify payloads.

## Search MCP

- `server/services/searchMcp.ts` — HTTP client to `SEARCH_MCP_BASE_URL` (default `https://mcp.baisoln.com/search`) with API key from Vault path `platform/search-mcp` or env `SEARCH_MCP_API_KEY`.

## Cloudflare DNS

- `server/services/cloudflareDns.ts` — Player UI hostname and verification when not skipped by environment flags.

## Langfuse

- `server/services/langfuseAdmin.ts` — Project creation during provisioning.
