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

echo "→ [2/5] Generating NOTIFY_WEBHOOK_TOKEN and writing to Vault…"
NOTIFY_TOKEN="$(openssl rand -hex 32)"
curl -fsS \
  --header "X-Vault-Token: $VAULT_TOKEN" \
  --request POST \
  --data "{\"data\":{\"webhook_token\":\"$NOTIFY_TOKEN\"}}" \
  "$VAULT_ADDR/v1/secret/data/platform/notify" > /dev/null
echo "  ok: secret/data/platform/notify (token length: ${#NOTIFY_TOKEN})"

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
  kubectl -n bionic-platform patch configmap bionic-platform-config --type merge -p "$(cat <<EOF
{
  "data": {
    "MAIL_FROM": "info@bionicaisolutions.com",
    "MAIL_SMTP_HOST": "smtp-relay.gmail.com",
    "MAIL_SMTP_PORT": "587",
    "SEARCH_MCP_BASE_URL": "https://mcp.baisoln.com/search",
    "BIONIC_INTERNAL_BASE_URL": "http://bionic-platform.bionic-platform.svc.cluster.local",
    "NOTIFY_WEBHOOK_TOKEN": "$NOTIFY_TOKEN"
  }
}
EOF
)"
  echo "  ok: configmap patched"

  echo "→ [5/5] Rolling restart of bionic-platform…"
  kubectl -n bionic-platform rollout restart deployment/bionic-platform
  kubectl -n bionic-platform rollout status deployment/bionic-platform --timeout=180s
  echo "  ok: deployment restarted"
else
  echo "  skipped (kubectl not available)"
  echo "  Manual step: add MAIL_FROM, MAIL_SMTP_HOST, MAIL_SMTP_PORT, SEARCH_MCP_BASE_URL,"
  echo "  BIONIC_INTERNAL_BASE_URL, NOTIFY_WEBHOOK_TOKEN=$NOTIFY_TOKEN to bionic-platform-config"
fi

echo
echo "✓ Crew platform setup complete."
echo "  Search MCP key:      vault secret/data/platform/search-mcp"
echo "  Notify webhook key:  vault secret/data/platform/notify  (token: $NOTIFY_TOKEN)"
echo "  Keycloak roles:      Admin, Analyst (realm: $KEYCLOAK_REALM)"
echo "  Mail from:           info@bionicaisolutions.com via smtp-relay.gmail.com:587"
