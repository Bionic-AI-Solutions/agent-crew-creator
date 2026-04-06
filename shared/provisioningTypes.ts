export type ServiceKey =
  | "livekit"
  | "keycloak"
  | "langfuse"
  | "kubernetes"
  | "postgres"
  | "redis"
  | "minio"
  | "letta"
  | "dify"
  | "vault_policy"
  | "verification";

export type StepStatus = "pending" | "running" | "success" | "failed" | "skipped";

export interface ProvisioningStep {
  name: ServiceKey;
  label: string;
  status: StepStatus;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export const SERVICE_LABELS: Record<ServiceKey, string> = {
  livekit: "LiveKit API Key",
  keycloak: "Keycloak OIDC Clients",
  langfuse: "Langfuse Observability",
  kubernetes: "Kubernetes Namespace",
  postgres: "PostgreSQL Database",
  redis: "Redis Key Prefix",
  minio: "MinIO Object Storage",
  letta: "Letta Memory Tenant",
  dify: "Dify Crew Engine",
  vault_policy: "Vault Secrets & Policy",
  verification: "Connectivity Verification",
};

export const DELETE_LABELS: Record<string, string> = {
  backup_postgres: "Backup PostgreSQL",
  backup_redis: "Backup Redis Keys",
  revoke_minio: "Revoke MinIO Access",
  document_keycloak: "Document Keycloak Config",
  document_keys: "Document Vault Keys",
  delete_postgres: "Delete PostgreSQL Database",
  delete_redis: "Delete Redis Keys",
  delete_minio: "Delete MinIO Bucket",
  delete_keycloak: "Delete Keycloak Clients",
  delete_langfuse: "Delete Langfuse Project",
  delete_letta: "Delete Letta Tenant",
  delete_livekit: "Remove LiveKit Key",
  delete_kubernetes: "Delete Kubernetes Namespace",
  delete_vault: "Delete Vault Secrets & Policy",
  verify_deletion: "Verify Deletion",
};
