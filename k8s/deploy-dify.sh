#!/bin/bash
# deploy-dify.sh - Deploy Dify AI Workflow Engine (crew execution engine for Bionic Platform)
# Namespace: bionic-platform (shared with platform itself)
# Images: langgenius/dify-api:1.5.0, langgenius/dify-web:1.5.0,
#         langgenius/dify-sandbox:0.2.10, langgenius/dify-plugin-daemon:0.5.6-local
# Access: Proxied through platform at /dify/* (no separate ingress)
#
# Components:
#   dify-api          — REST API server (port 5001)
#   dify-worker       — Celery async worker (same image, MODE=worker)
#   dify-web          — Next.js frontend (port 3000)
#   dify-sandbox      — Code execution sandbox (port 8194)
#   dify-plugin-daemon — Plugin management daemon (port 5002)
#
# LLM: Uses local GPU models via HTTP Request nodes in workflows:
#   llm-deep.mcp.svc.cluster.local:8005  (Qwen 3.5 27B)
#   llm-fast.mcp.svc.cluster.local:8015  (Gemma 4 E4B)
#
# Usage:
#   ./deploy-dify.sh              # Full fresh deploy
#   ./deploy-dify.sh --upgrade    # Re-apply manifests only
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

source "${DEPLOY_DIR}/lib/common.sh"
source "${DEPLOY_DIR}/lib/secrets.sh"

NAMESPACE="bionic-platform"
MANIFEST_DIR="${DEPLOY_DIR}/tier6-apps/manifests/dify"

# ============================================================================
# Step 1: Ensure namespace exists
# ============================================================================
step_create_namespace() {
    step 1 "Ensuring namespace '${NAMESPACE}' exists..."
    create_namespace "${NAMESPACE}" 2>/dev/null || true
}

# ============================================================================
# Step 2: Create PostgreSQL database for Dify
# ============================================================================
step_setup_postgresql() {
    step 2 "Setting up PostgreSQL database 'dify'..."
    load_env

    local pg_pod
    pg_pod=$(find_pg_primary)
    if [[ -n "$pg_pod" ]]; then
        # Create database if not exists
        kubectl exec -n pg "$pg_pod" -c postgres -- \
            psql -U postgres -c "SELECT 1 FROM pg_database WHERE datname='dify'" | grep -q 1 || \
            kubectl exec -n pg "$pg_pod" -c postgres -- \
                psql -U postgres -c "CREATE DATABASE dify;" 2>/dev/null || true

        # Install extensions
        kubectl exec -n pg "$pg_pod" -c postgres -- \
            psql -U postgres -d dify -c "CREATE EXTENSION IF NOT EXISTS vector;" 2>/dev/null || true
        kubectl exec -n pg "$pg_pod" -c postgres -- \
            psql -U postgres -d dify -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;" 2>/dev/null || true
        kubectl exec -n pg "$pg_pod" -c postgres -- \
            psql -U postgres -d dify -c "CREATE EXTENSION IF NOT EXISTS uuid-ossp;" 2>/dev/null || true

        log "PostgreSQL database 'dify' ready"
    else
        warn "Could not find PostgreSQL primary pod"
    fi
}

# ============================================================================
# Step 3: Create MinIO bucket for Dify storage
# ============================================================================
step_setup_minio() {
    step 3 "Setting up MinIO bucket 'bionic-dify'..."
    load_env
    require_env MINIO_ROOT_PASSWORD

    kubectl run minio-dify-setup \
        --image=minio/mc:latest \
        --restart=Never \
        --namespace=minio \
        --rm -i \
        --command -- /bin/sh -c "
set -e
for i in \$(seq 1 30); do
    if mc alias set minio-admin http://minio-tenant-hl.minio.svc.cluster.local:9000 admin '${MINIO_ROOT_PASSWORD}' 2>/dev/null; then
        break
    fi
    sleep 5
done
mc mb minio-admin/bionic-dify --ignore-existing
echo 'MinIO bucket bionic-dify ready'
" 2>/dev/null || warn "MinIO setup may have had issues - check bucket manually"

    log "MinIO bucket ready"
}

# ============================================================================
# Step 4: Apply ConfigMap (substitute secrets)
# ============================================================================
step_apply_configmap() {
    step 4 "Applying Dify ConfigMap..."
    load_env
    require_env PG_PASSWORD DIFY_SECRET_KEY DIFY_INNER_API_KEY

    # Substitute env vars in configmap template and apply
    envsubst < "${MANIFEST_DIR}/configmap.yaml" | kubectl apply -f -
    log "ConfigMap applied"
}

# ============================================================================
# Step 5: Deploy all Dify workloads
# ============================================================================
step_deploy_workloads() {
    step 5 "Deploying Dify workloads..."

    kubectl apply -f "${MANIFEST_DIR}/service.yaml"
    kubectl apply -f "${MANIFEST_DIR}/deployment.yaml"

    log "Waiting for dify-api to be ready..."
    kubectl rollout status deploy/dify-api -n "${NAMESPACE}" --timeout=120s

    log "Waiting for dify-plugin-daemon to be ready..."
    kubectl rollout status deploy/dify-plugin-daemon -n "${NAMESPACE}" --timeout=120s

    log "All Dify workloads deployed"
}

# ============================================================================
# Step 6: Run database migrations
# ============================================================================
step_run_migrations() {
    step 6 "Running Dify database migrations..."

    # Wait for API pod to be ready
    kubectl wait --for=condition=ready pod -l app=dify-api -n "${NAMESPACE}" --timeout=60s

    # Run Flask migrations
    kubectl exec -n "${NAMESPACE}" deploy/dify-api -- flask db upgrade 2>&1 | tail -5 || \
        warn "Migration may have had issues - check logs"

    log "Migrations complete"
}

# ============================================================================
# Step 7: Initialize Dify (create admin account)
# ============================================================================
step_init_dify() {
    step 7 "Initializing Dify (admin account)..."
    load_env

    # Admin credentials must be sourced from the operator's env (typically
    # populated from Vault via `vault kv get secret/t6-apps/bionic-platform/config`
    # before running this script). No hardcoded defaults — setup never
    # happens with a known password.
    local admin_email="${DIFY_ADMIN_EMAIL:-}"
    local admin_password="${DIFY_ADMIN_PASSWORD:-}"
    if [[ -z "$admin_email" || -z "$admin_password" ]]; then
        error "DIFY_ADMIN_EMAIL and DIFY_ADMIN_PASSWORD must be set in env."
        error "Retrieve from Vault before running:"
        error "  export DIFY_ADMIN_EMAIL=\$(vault kv get -field=dify_admin_email secret/t6-apps/bionic-platform/config)"
        error "  export DIFY_ADMIN_PASSWORD=\$(vault kv get -field=dify_admin_password secret/t6-apps/bionic-platform/config)"
        return 1
    fi

    # Check if already initialized
    local setup_status
    setup_status=$(kubectl exec -n "${NAMESPACE}" deploy/dify-api -- \
        curl -s http://localhost:5001/console/api/setup 2>&1 | grep -o '"step":"[^"]*"' | head -1)

    if echo "$setup_status" | grep -q "not_started"; then
        kubectl exec -n "${NAMESPACE}" deploy/dify-api -- \
            curl -s -X POST http://localhost:5001/console/api/setup \
            -H "Content-Type: application/json" \
            -d "{\"email\":\"${admin_email}\",\"name\":\"Admin\",\"password\":\"${admin_password}\"}" \
            2>&1 | grep -o '"result":"[^"]*"'
        log "Admin account created: ${admin_email}"
    else
        log "Dify already initialized"
    fi
}

# ============================================================================
# Step 8: Verify deployment
# ============================================================================
step_verify() {
    step 8 "Verifying Dify deployment..."

    # Health check
    local health
    health=$(kubectl exec -n "${NAMESPACE}" deploy/dify-api -- \
        curl -s http://localhost:5001/v1/health 2>&1)
    if echo "$health" | grep -q '"ok"'; then
        log "Dify API health: OK"
    else
        warn "Dify API health check failed: $health"
    fi

    # Check all pods
    local pods
    pods=$(kubectl get pods -n "${NAMESPACE}" -l "app.kubernetes.io/managed-by=bionic-platform" \
        --no-headers 2>/dev/null | wc -l)
    log "Dify pods running: ${pods}"

    # Print summary
    echo ""
    echo "════════════════════════════════════════════════════"
    echo "  Dify Deployment Summary"
    echo "════════════════════════════════════════════════════"
    echo "  Namespace:  ${NAMESPACE}"
    echo "  API:        http://dify-api.${NAMESPACE}.svc.cluster.local:5001"
    echo "  Web:        http://dify-web.${NAMESPACE}.svc.cluster.local:3000"
    echo "  Proxy:      https://platform.baisoln.com/dify/"
    echo "  Admin:      ${DIFY_ADMIN_EMAIL:-<not-set>}"
    echo "  LLM (deep): http://llm-deep.mcp.svc.cluster.local:8005"
    echo "  LLM (fast): http://llm-fast.mcp.svc.cluster.local:8015"
    echo "════════════════════════════════════════════════════"
}

# ============================================================================
# Main
# ============================================================================
main() {
    banner "Dify AI Workflow Engine"

    if [[ "${1:-}" == "--upgrade" ]]; then
        step_apply_configmap
        step_deploy_workloads
        step_verify
    else
        step_create_namespace
        step_setup_postgresql
        step_setup_minio
        step_apply_configmap
        step_deploy_workloads
        step_run_migrations
        step_init_dify
        step_verify
    fi
}

main "$@"
