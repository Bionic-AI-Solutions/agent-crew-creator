/**
 * Centralized service configuration.
 * All internal K8s service URLs are defined here with env var overrides.
 * This is the single source of truth — import from here, not inline defaults.
 */

export const config = {
  minio: {
    endpoint: process.env.MINIO_ENDPOINT || "minio-tenant-hl.minio.svc.cluster.local:9000",
    adminEndpoint: process.env.MINIO_ADMIN_ENDPOINT || "minio.minio.svc.cluster.local:80",
    rootUser: process.env.MINIO_ROOT_USER || "",
    rootPassword: process.env.MINIO_ROOT_PASSWORD || "",
    useSSL: process.env.MINIO_USE_SSL === "true",
  },
  dify: {
    namespace: process.env.DIFY_NAMESPACE || "bionic-platform",
    apiUrl: process.env.DIFY_API_URL || "http://dify-api.bionic-platform.svc.cluster.local:5001",
    webUrl: process.env.DIFY_WEB_URL || "http://dify-web.bionic-platform.svc.cluster.local:3000",
    externalUrl: process.env.DIFY_EXTERNAL_BASE_URL || "https://dify.baisoln.com",
  },
  livekit: {
    namespace: process.env.K8S_LIVEKIT_NAMESPACE || "livekit",
    internalUrl: process.env.LIVEKIT_INTERNAL_URL || "ws://livekit-server.livekit.svc.cluster.local:7880",
    keysSecretName: process.env.LIVEKIT_KEYS_SECRET_NAME || "livekit-api-keys",
  },
  keycloak: {
    url: process.env.KEYCLOAK_URL || "https://auth.bionicaisolutions.com",
    internalUrl: process.env.KEYCLOAK_INTERNAL_URL || "http://keycloak.keycloak.svc.cluster.local:80",
    realm: process.env.KEYCLOAK_REALM || "Bionic",
  },
  langfuse: {
    host: process.env.LANGFUSE_HOST || "http://langfuse-web.langfuse.svc.cluster.local:3000",
  },
  kong: {
    proxyUrl: process.env.PLAYER_UI_KONG_VERIFY_URL || "http://kong-kong-proxy.kong.svc.cluster.local:80",
  },
  letta: {
    baseUrl: process.env.LETTA_BASE_URL || "http://letta-server.letta.svc.cluster.local:8283",
  },
  vault: {
    addr: process.env.VAULT_ADDR || "",
    token: process.env.VAULT_TOKEN || "",
  },
  postgres: {
    host: process.env.PG_HOST || "pg-ceph-rw.pg.svc.cluster.local",
    port: parseInt(process.env.PG_PORT || "5432", 10),
    adminUser: process.env.PG_ADMIN_USER || "postgres",
    adminPassword: process.env.PG_ADMIN_PASSWORD || "",
  },
  redis: {
    url: process.env.REDIS_URL || "",
  },
  platform: {
    internalUrl: process.env.PLATFORM_INTERNAL_URL || "http://bionic-platform.bionic-platform.svc.cluster.local:80",
    webhookBaseUrl: process.env.WEBHOOK_BASE_URL || "https://platform.baisoln.com",
  },
  nfs: {
    server: process.env.MODEL_CACHE_NFS_SERVER || "192.168.0.109",
    path: process.env.MODEL_CACHE_NFS_PATH || "/export/model-cache",
  },
  bithuman: {
    apiUrl: process.env.BITHUMAN_API_URL || "http://192.168.0.10:8089/launch",
  },
  playerUi: {
    hostSuffix: process.env.PLAYER_UI_HOST_SUFFIX || "baisoln.com",
    ingressClass: process.env.PLAYER_UI_INGRESS_CLASS || "kong",
    certIssuer: process.env.PLAYER_UI_CERT_ISSUER || "",
  },
};
