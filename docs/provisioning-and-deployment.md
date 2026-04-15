# Provisioning and deployment

## App provisioning pipeline

Primary implementation: `server/services/provisioner.ts`. Triggered from `server/appRouter.ts` when an admin creates an app (`runProvisioningJob`).

### Provisioning steps (`ServiceKey`)

Defined in `shared/provisioningTypes.ts`. Typical order when creating an app (`server/appRouter.ts`):

1. `livekit` — Per-app LiveKit API key and secret; written to Vault and LiveKit ExternalSecret path; may restart LiveKit server (`server/k8sClient.ts`).
2. `keycloak` — Per-app public and confidential OIDC clients (`server/services/keycloakAdmin.ts`).
3. `langfuse` — Project and keys (`server/services/langfuseAdmin.ts`).
4. `kubernetes` — Namespace, resource quota, service account (`server/k8sClient.ts`).
5. `postgres` — Database and credentials (`server/services/postgresAdmin.ts`).
6. `redis` — Redis URL and key prefix (`server/services/redisAdmin.ts`).
7. `minio` — Bucket and service account (`server/services/minioAdmin.ts`).
8. `letta` — Letta tenant registration; shared `LETTA_API_KEY` may be stored in app secrets (`lettaAdmin.createTenant`).
9. `dify` — Shared Dify instance: API keys generated and stored in Vault (not a full per-app Dify deployment in the current path).
10. `vault_policy` — Merge secrets into Vault, ESO policy, ExternalSecret for the app namespace.
11. `player_ui` — Optional: player UI image build, Kubernetes apply, Cloudflare DNS (unless `PLAYER_UI_SKIP_CLOUDFLARE_DNS`).
12. `verification` — Connectivity checks, player-ui readiness, optional public DNS verification.

### Deletion

- `runDeletionJob` from `server/appRouter.ts` invokes teardown steps; labels and semantics are in `DELETE_LABELS` in `shared/provisioningTypes.ts`.

## Agent deployment

- `server/services/agentDeployer.ts` ensures ConfigMap, ExternalSecret, and Deployment in the app namespace (`slug`).
- Injects provider API keys from Vault (`agent_${id}_${provider}_api_key`) with optional shared fallback from `secret/shared/api-keys`.
- GPU and internal URLs are configurable via environment variables (see `environment-variables.md`).

## Kubernetes reference manifests

- Directory `k8s/` contains manifests for deploying the platform (`deployment.yaml`, `ingress.yaml`, `external-secret.yaml`, etc.) and `deploy-dify.sh` for the Dify stack.

## Docker image

- Root `Dockerfile`: builds the Vite client and embed bundles, copies server sources, runs `npx tsx server/index.ts` in the runner stage.
