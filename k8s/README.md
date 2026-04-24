# k8s/ — app-specific leftovers

The Kubernetes manifests for the **Bionic Platform** (namespace,
Deployment, Service, Ingress, ConfigMap, ExternalSecret, RBAC) have
moved to the central deploy repo:

- Manifests: `deploy/k8s-infrastructure/deploy/tier6-apps/manifests/bionic-platform/`
- ExternalSecret: `deploy/k8s-infrastructure/deploy/vault/apps/bionic-platform/external-secret.yaml`
- Deploy script: `deploy/k8s-infrastructure/deploy/tier6-apps/deploy-bionic-platform.sh`

Install the platform with:

```sh
deploy/k8s-infrastructure/deploy/tier6-apps/deploy-bionic-platform.sh
```

Vault keys required at `secret/t6-apps/bionic-platform/config`:

```
database_url, session_secret,
keycloak_client_id, keycloak_client_secret,
keycloak_admin_user, keycloak_admin_password,
vault_token, letta_api_key,
minio_root_user, minio_root_password, pg_admin_url,
langfuse_admin_password, langfuse_org_id, langfuse_db_host,
notify_webhook_token,
dify_admin_email, dify_admin_password
```

## What remains here

- `deploy-dify.sh` — bootstraps the Dify instance (separate dependency
  deployed into the same `bionic-platform` namespace). Admin creds
  should be sourced from the same Vault path and exported as env before
  running the script; do not commit values.
- `research-crew-template.yml` — sample Dify workflow DSL used by the
  bootstrap script.
