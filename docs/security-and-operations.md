# Security and operations

## High-risk areas (code-backed review)

1. **`GET /dify-login`** — Performs Dify console login and may redirect with tokens in the query string. If exposed without additional controls, this is a critical finding. See `server/index.ts`.
2. **Dify web proxy** — Removes `X-Frame-Options` from upstream responses to allow iframe embedding. Requires compensating controls (strict CSP on trusted parent origins). See `server/index.ts`.
3. **Public embed and s3-proxy** — No session authentication; security relies on embed token secrecy, optional origin allowlists, response content-type checks, and edge rate limiting. See `server/embedPublicRoutes.ts`.
4. **Notify webhook** — If `NOTIFY_WEBHOOK_TOKEN` and Vault `platform/notify` are both absent, the handler may accept unauthenticated requests. See `server/services/notifyService.ts`.
5. **Vault unconfigured** — `vaultClient` skips operations when `VAULT_ADDR` / `VAULT_TOKEN` are missing. Production deployments should treat missing Vault as a hard failure for provisioning paths. See `server/vaultClient.ts`.
6. **MinIO credentials on document upload** — Uses platform-level root-style credentials in `server/index.ts` for `putObject`. Prefer dedicated credentials with write-only access to app buckets.

## Operational checklist

- [ ] `SESSION_SECRET` set in production
- [ ] `DATABASE_URL` set for all environments that serve data
- [ ] Vault address and token set where provisioning and secrets are required
- [ ] `PLAYER_UI_INTERNAL_TOKEN` set in production if player-ui calls the platform
- [ ] `NOTIFY_WEBHOOK_TOKEN` or Vault `platform/notify` configured if `/api/webhooks/notify` is reachable
- [ ] Keycloak admin password rotated; least privilege for automation account
- [ ] Ingress TLS, rate limits, and WAF rules for public embed paths

## Logging

- Central logger: `server/_core/logger.ts`. Ensure log pipelines do not record bearer tokens, presigned query strings, or embed tokens.
