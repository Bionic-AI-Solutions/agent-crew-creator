#!/usr/bin/env bash
# Platform-level one-shot setup for the crew templates feature.
#
# Performs:
#   1. Writes the Search MCP API key to Vault (secret/data/platform/search-mcp)
#   2. Generates a NOTIFY_WEBHOOK_TOKEN and writes it to Vault
#   3. Creates the platform-wide Keycloak realm roles "Admin" and "Analyst"
#   4. Patches the bionic-platform ConfigMap with the env vars the crew
#      installer needs (MAIL_FROM, BIONIC_INTERNAL_BASE_URL, SEARCH_MCP_BASE_URL)
#   5. Restarts the bionic-platform deployment so it picks up the new envs
#
# Idempotent — safe to re-run.
#
# Required env (export before running):
#   VAULT_ADDR        — e.g. https://vault.bionicaisolutions.com
#   VAULT_TOKEN       — vault root or platform-write token
#   KEYCLOAK_URL      — e.g. https://auth.bionicaisolutions.com
#   KEYCLOAK_REALM    — defaults to "Bionic"
#   KC_ADMIN_USER     — keycloak admin user
#   KC_ADMIN_PASS     — keycloak admin password
#
# Search MCP key is hard-coded in this script (per the user's instruction
# that it's safe to commit because it's only valid from inside the cluster).
# Override via SEARCH_MCP_API_KEY env var.

set -euo pipefail

SEARCH_MCP_API_KEY="${SEARCH_MCP_API_KEY:-97f2b878e2d4505e0aeba058b1f0876357d6dbc4c8dc9560e17ac453781e351e}"
KEYCLOAK_REALM="${KEYCLOAK_REALM:-Bionic}"

# ── 0. Pre-flight ────────────────────────────────────────────────
need() {
  if [[ -z "${!1:-}" ]]; then
    echo "ERROR: \$$1 is required" >&2
    exit 1
  fi
}
need VAULT_ADDR
need VAULT_TOKEN
need KEYCLOAK_URL
need KC_ADMIN_USER
need KC_ADMIN_PASS

command -v curl >/dev/null || { echo "curl required"; exit 1; }
command -v jq   >/dev/null || { echo "jq required"; exit 1; }
command -v kubectl >/dev/null || echo "WARN: kubectl missing — skipping configmap patch + restart"

echo "→ [1/5] Writing Search MCP key to Vault…"
curl -fsS \
  --header "X-Vault-Token: $VAULT_TOKEN" \
  --request POST \
  --data "{\"data\":{\"api_key\":\"$SEARCH_MCP_API_KEY\"}}" \
  "$VAULT_ADDR/v1/secret/data/platform/search-mcp" > /dev/null
echo "  ok: secret/data/platform/search-mcp"

echo "→ [2/5] Generating NOTIFY_WEBHOOK_TOKEN and merging into bionic-platform Vault config…"
NOTIFY_TOKEN="$(openssl rand -hex 32)"
# Merge into the existing per-app KV that ESO already syncs to bionic-platform-secrets.
# We read the current data first so we don't clobber other keys (database_url etc).
EXISTING_JSON="$(curl -fsS --header "X-Vault-Token: $VAULT_TOKEN" \
  "$VAULT_ADDR/v1/secret/data/t6-apps/bionic-platform/config" | jq -c '.data.data // {}')"
MERGED_JSON="$(echo "$EXISTING_JSON" | jq -c --arg t "$NOTIFY_TOKEN" '. + {notify_webhook_token: $t}')"
curl -fsS \
  --header "X-Vault-Token: $VAULT_TOKEN" \
  --request POST \
  --data "{\"data\":$MERGED_JSON}" \
  "$VAULT_ADDR/v1/secret/data/t6-apps/bionic-platform/config" > /dev/null
echo "  ok: secret/data/t6-apps/bionic-platform/config[notify_webhook_token] (length: ${#NOTIFY_TOKEN})"
# Also write to the platform/notify path so the runtime fallback in
# notifyService.getNotifyToken() keeps working if the env var is missing.
curl -fsS \
  --header "X-Vault-Token: $VAULT_TOKEN" \
  --request POST \
  --data "{\"data\":{\"webhook_token\":\"$NOTIFY_TOKEN\"}}" \
  "$VAULT_ADDR/v1/secret/data/platform/notify" > /dev/null
echo "  ok: secret/data/platform/notify (fallback path)"

echo "→ [3/5] Creating Keycloak realm roles Admin + Analyst…"
KC_TOKEN="$(curl -fsS \
  -d "grant_type=password" \
  -d "client_id=admin-cli" \
  -d "username=$KC_ADMIN_USER" \
  -d "password=$KC_ADMIN_PASS" \
  "$KEYCLOAK_URL/realms/master/protocol/openid-connect/token" | jq -r .access_token)"

create_role() {
  local name="$1"
  local desc="$2"
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' \
    -X POST \
    -H "Authorization: Bearer $KC_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"$name\",\"description\":\"$desc\"}" \
    "$KEYCLOAK_URL/admin/realms/$KEYCLOAK_REALM/roles")
  case "$code" in
    201) echo "  ok: created $name" ;;
    409) echo "  ok: $name already exists" ;;
    *)   echo "  WARN: create $name returned HTTP $code" ;;
  esac
}
create_role "Admin"   "Platform administrator (full access)"
create_role "Analyst" "Analyst — can install and run crew templates"

echo "→ [4/5] Patching bionic-platform ConfigMap…"
if command -v kubectl >/dev/null; then
  kubectl -n bionic-platform patch configmap bionic-platform-config --type merge -p "$(cat <<'EOF'
{
  "data": {
    "MAIL_FROM": "info@bionicaisolutions.com",
    "MAIL_SMTP_HOST": "smtp-relay.gmail.com",
    "MAIL_SMTP_PORT": "587",
    "SEARCH_MCP_BASE_URL": "https://mcp.baisoln.com/search",
    "BIONIC_INTERNAL_BASE_URL": "http://bionic-platform.bionic-platform.svc.cluster.local"
  }
}
EOF
)"
  # Strip NOTIFY_WEBHOOK_TOKEN if a previous run wrote it as plaintext
  kubectl -n bionic-platform patch configmap bionic-platform-config --type=json \
    -p='[{"op":"remove","path":"/data/NOTIFY_WEBHOOK_TOKEN"}]' 2>/dev/null || true
  echo "  ok: configmap patched"

  # Force ESO to refresh the k8s secret immediately (rather than waiting up to 5m)
  kubectl -n bionic-platform annotate externalsecret bionic-platform-secrets \
    force-sync="$(date +%s)" --overwrite >/dev/null 2>&1 || true
  # Wait briefly for the ESO controller to materialise the new key, then verify
  for i in 1 2 3 4 5 6; do
    if kubectl -n bionic-platform get secret bionic-platform-secrets \
        -o jsonpath='{.data.notify_webhook_token}' 2>/dev/null | grep -q .; then
      echo "  ok: notify_webhook_token synced into k8s secret"
      break
    fi
    sleep 5
  done

  echo "→ [5/5] Rolling restart of bionic-platform…"
  kubectl -n bionic-platform rollout restart deployment/bionic-platform
  kubectl -n bionic-platform rollout status deployment/bionic-platform --timeout=180s
  echo "  ok: deployment restarted"
else
  echo "  skipped (kubectl not available)"
  echo "  Manual steps:"
  echo "    1. Apply k8s/configmap.yaml and k8s/deployment.yaml"
  echo "    2. The notify webhook token is in vault t6-apps/bionic-platform/config[notify_webhook_token]"
  echo "    3. ESO will sync it into bionic-platform-secrets within 5m, OR force with:"
  echo "       kubectl -n bionic-platform annotate externalsecret bionic-platform-secrets force-sync=\$(date +%s) --overwrite"
fi

echo
echo "✓ Crew platform setup complete."
echo "  Search MCP key:      vault secret/data/platform/search-mcp"
echo "  Notify webhook key:  vault secret/data/platform/notify  (token: $NOTIFY_TOKEN)"
echo "  Keycloak roles:      Admin, Analyst (realm: $KEYCLOAK_REALM)"
echo "  Mail from:           info@bionicaisolutions.com via smtp-relay.gmail.com:587"
