/**
 * Kubernetes client for managing app namespaces, agent deployments,
 * LiveKit keys, and ExternalSecrets.
 *
 * Uses @kubernetes/client-node v1.4.0 which requires { body: ... } named params.
 */
import { createLogger } from "./_core/logger.js";
import { vault } from "./vaultClient.js";

const log = createLogger("K8s");

const K8S_LIVEKIT_NAMESPACE = process.env.K8S_LIVEKIT_NAMESPACE || "livekit";
const LIVEKIT_KEYS_SECRET = process.env.LIVEKIT_KEYS_SECRET_NAME || "livekit-api-keys";
// Vault path that backs the livekit-api-keys ExternalSecret. The ESO syncs
// this path to the K8s secret every 5min, so writing directly to the K8s
// secret is futile — ESO will overwrite it on the next sync.
const LIVEKIT_VAULT_PATH = process.env.LIVEKIT_VAULT_PATH || "t6-apps/livekit/config";
const LIVEKIT_EXTERNAL_SECRET_NAME =
  process.env.LIVEKIT_EXTERNAL_SECRET_NAME || "livekit-api-keys";
const AGENT_MODEL_CACHE_NFS_SERVER = process.env.AGENT_MODEL_CACHE_NFS_SERVER || "192.168.0.109";
const AGENT_MODEL_CACHE_NFS_PATH =
  process.env.AGENT_MODEL_CACHE_NFS_PATH || "/volume1/docker/bionic-shared/agent-models";

/** Check if a K8s client error is a 404 Not Found */
function is404(err: any): boolean {
  return err?.code === 404 || err?.statusCode === 404 || err?.body?.code === 404 ||
    (typeof err?.message === "string" && err.message.includes("HTTP-Code: 404"));
}

/** Check if a K8s client error is a 409 Conflict (already exists) */
function is409(err: any): boolean {
  return err?.code === 409 || err?.statusCode === 409 || err?.body?.reason === "AlreadyExists" ||
    (typeof err?.message === "string" && err.message.includes("HTTP-Code: 409"));
}

let _k8sApi: any = null;
let _k8sAppsApi: any = null;
let _k8sCustomApi: any = null;

async function getK8sApis() {
  if (_k8sApi) return { coreApi: _k8sApi, appsApi: _k8sAppsApi, customApi: _k8sCustomApi };

  const k8s = await import("@kubernetes/client-node");
  const kc = new k8s.KubeConfig();

  if (process.env.KUBECONFIG) {
    kc.loadFromFile(process.env.KUBECONFIG);
  } else {
    try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); }
  }

  _k8sApi = kc.makeApiClient(k8s.CoreV1Api);
  _k8sAppsApi = kc.makeApiClient(k8s.AppsV1Api);
  _k8sCustomApi = kc.makeApiClient(k8s.CustomObjectsApi);
  return { coreApi: _k8sApi, appsApi: _k8sAppsApi, customApi: _k8sCustomApi };
}

// ── Namespace Management ────────────────────────────────────────

export async function createNamespace(name: string): Promise<void> {
  try {
    const { coreApi } = await getK8sApis();
    await coreApi.createNamespace({
      body: {
        metadata: { name, labels: { "app.kubernetes.io/managed-by": "bionic-platform" } },
      },
    });
    log.info("Created namespace", { name });
  } catch (err: any) {
    if (is409(err)) {
      log.info("Namespace already exists", { name });
      return;
    }
    throw err;
  }
}

export async function deleteNamespace(name: string): Promise<void> {
  try {
    const { coreApi } = await getK8sApis();
    await coreApi.deleteNamespace({ name });
    log.info("Deleted namespace", { name });
  } catch (err: any) {
    if (is404(err)) return;
    throw err;
  }
}

export async function createResourceQuota(namespace: string): Promise<void> {
  try {
    const { coreApi } = await getK8sApis();
    await coreApi.createNamespacedResourceQuota({
      namespace,
      body: {
        metadata: { name: `${namespace}-quota` },
        spec: {
          hard: { "requests.cpu": "4", "requests.memory": "8Gi", "limits.cpu": "8", "limits.memory": "16Gi", pods: "20" },
        },
      },
    });
    log.info("Created resource quota", { namespace });
  } catch (err: any) {
    if (is409(err)) return;
    log.warn("Failed to create resource quota", { error: String(err?.body?.message || err) });
  }
}

export async function createServiceAccount(namespace: string): Promise<void> {
  try {
    const { coreApi } = await getK8sApis();
    await coreApi.createNamespacedServiceAccount({
      namespace,
      body: { metadata: { name: `${namespace}-sa` } },
    });
    log.info("Created service account", { namespace });
  } catch (err: any) {
    if (is409(err)) return;
    log.warn("Failed to create service account", { error: String(err?.body?.message || err) });
  }
}

// ── LiveKit Key Management ──────────────────────────────────────
//
// LiveKit's API key map (`LIVEKIT_KEYS` env on livekit-server) is synced from
// Vault by ESO on a 5-min refresh. Writing to the K8s secret directly causes
// the value to be reverted on the next sync. The proper flow is:
//   1. write the per-tenant key pair into Vault under LIVEKIT_VAULT_PATH
//   2. patch the ExternalSecret to add data refs + extend the LIVEKIT_KEYS template
//   3. force ESO to re-sync now (annotation bump)
//   4. restart livekit-server so it re-reads the env

function livekitVaultProps(slug: string) {
  return {
    keyProp: `${slug}_api_key`,
    secretProp: `${slug}_api_secret`,
    secretKeyKey: `${slug}_api_key`,
    secretKeySecret: `${slug}_api_secret`,
  };
}

async function patchLivekitExternalSecret(slug: string, op: "add" | "remove"): Promise<void> {
  const { customApi } = await getK8sApis();
  const props = livekitVaultProps(slug);

  // Read current ExternalSecret
  const current: any = await customApi.getNamespacedCustomObject({
    group: "external-secrets.io",
    version: "v1",
    namespace: K8S_LIVEKIT_NAMESPACE,
    plural: "externalsecrets",
    name: LIVEKIT_EXTERNAL_SECRET_NAME,
  });
  const es = current?.body || current;
  if (!es?.spec) throw new Error("livekit-api-keys ExternalSecret not found");

  const data: Array<{ secretKey: string; remoteRef: { key: string; property: string } }> = es.spec.data || [];
  const tplData: Record<string, string> = es.spec.target?.template?.data || {};
  const livekitKeysTpl: string = tplData.LIVEKIT_KEYS || "";

  const filtered = data.filter(
    (d) => d.secretKey !== props.secretKeyKey && d.secretKey !== props.secretKeySecret,
  );
  const lines = livekitKeysTpl.split("\n");
  const cleaned = lines.filter(
    (l) => !l.includes(`{{ .${props.secretKeyKey} }}`) && !l.includes(`{{ .${props.secretKeySecret} }}`),
  );

  if (op === "add") {
    filtered.push(
      { secretKey: props.secretKeyKey, remoteRef: { key: LIVEKIT_VAULT_PATH, property: props.keyProp } },
      { secretKey: props.secretKeySecret, remoteRef: { key: LIVEKIT_VAULT_PATH, property: props.secretProp } },
    );
    // Append the new tenant line before the trailing newline (if any).
    const trailingNewline = livekitKeysTpl.endsWith("\n");
    const body = cleaned.filter((l) => l !== "").join("\n");
    const newLine = `{{ .${props.secretKeyKey} }}: {{ .${props.secretKeySecret} }}`;
    tplData.LIVEKIT_KEYS = body + (body ? "\n" : "") + newLine + (trailingNewline ? "\n" : "");
  } else {
    tplData.LIVEKIT_KEYS = cleaned.join("\n");
  }

  es.spec.data = filtered;
  if (!es.spec.target) es.spec.target = {};
  if (!es.spec.target.template) es.spec.target.template = {};
  es.spec.target.template.data = tplData;

  // Annotate to force ESO to resync immediately (bypass refreshInterval).
  if (!es.metadata.annotations) es.metadata.annotations = {};
  es.metadata.annotations["force-sync"] = String(Math.floor(Date.now() / 1000));

  await customApi.replaceNamespacedCustomObject({
    group: "external-secrets.io",
    version: "v1",
    namespace: K8S_LIVEKIT_NAMESPACE,
    plural: "externalsecrets",
    name: LIVEKIT_EXTERNAL_SECRET_NAME,
    body: es,
  });
}

export async function upsertLivekitKey(slug: string, apiKey: string, apiSecret: string): Promise<void> {
  try {
    const props = livekitVaultProps(slug);
    // 1. Merge the per-tenant key pair into the shared Vault path.
    await vault.mergeGenericSecret(LIVEKIT_VAULT_PATH, {
      [props.keyProp]: apiKey,
      [props.secretProp]: apiSecret,
    });

    // 2. Wire the new properties into the ExternalSecret + template, then force a sync.
    await patchLivekitExternalSecret(slug, "add");

    log.info("Wired LiveKit key into Vault + ExternalSecret", { slug });
  } catch (err) {
    log.error("Failed to provision LiveKit key", { slug, error: String(err) });
    throw err;
  }
}

export async function removeLivekitKey(slug: string): Promise<void> {
  try {
    const props = livekitVaultProps(slug);
    await patchLivekitExternalSecret(slug, "remove");
    await vault.deleteGenericSecretFields(LIVEKIT_VAULT_PATH, [props.keyProp, props.secretProp]);
    log.info("Removed LiveKit key from Vault + ExternalSecret", { slug });
  } catch (err) {
    log.warn("Failed to remove LiveKit key", { slug, error: String(err) });
  }
}

export async function restartLivekitServer(): Promise<void> {
  try {
    const { appsApi } = await getK8sApis();
    // Read current deployment, update annotation, replace
    const dep = await appsApi.readNamespacedDeployment({ name: "livekit-server", namespace: K8S_LIVEKIT_NAMESPACE });
    const body = dep?.body || dep;
    if (!body?.spec?.template?.metadata) {
      body.spec.template.metadata = {};
    }
    if (!body.spec.template.metadata.annotations) {
      body.spec.template.metadata.annotations = {};
    }
    body.spec.template.metadata.annotations["kubectl.kubernetes.io/restartedAt"] = new Date().toISOString();

    await appsApi.replaceNamespacedDeployment({
      name: "livekit-server",
      namespace: K8S_LIVEKIT_NAMESPACE,
      body,
    });
    log.info("Restarted LiveKit server");
  } catch (err: any) {
    log.warn("Failed to restart LiveKit server", { error: String(err?.body?.message || err) });
  }
}

// ── ExternalSecret Management ───────────────────────────────────

export async function createExternalSecret(namespace: string): Promise<void> {
  try {
    const { customApi } = await getK8sApis();
    await customApi.createNamespacedCustomObject({
      group: "external-secrets.io",
      version: "v1",
      namespace,
      plural: "externalsecrets",
      body: {
        apiVersion: "external-secrets.io/v1",
        kind: "ExternalSecret",
        metadata: { name: `${namespace}-secrets`, namespace },
        spec: {
          refreshInterval: "5m",
          secretStoreRef: { name: "vault-backend", kind: "ClusterSecretStore" },
          target: { name: `${namespace}-secrets` },
          dataFrom: [{ extract: { key: `t6-apps/${namespace}/config` } }],
        },
      },
    });
    log.info("Created ExternalSecret", { namespace });
  } catch (err: any) {
    if (is409(err)) {
      log.info("ExternalSecret already exists", { namespace });
      return;
    }
    log.warn("Failed to create ExternalSecret", { error: String(err?.body?.message || err) });
  }
}

// ── ConfigMap Management ────────────────────────────────────────

export async function ensureConfigMap(
  namespace: string,
  name: string,
  data: Record<string, string>,
): Promise<void> {
  const { coreApi } = await getK8sApis();
  const body = { metadata: { name, namespace }, data };

  try {
    await coreApi.readNamespacedConfigMap({ name, namespace });
    await coreApi.replaceNamespacedConfigMap({ name, namespace, body });
    log.info("Updated ConfigMap", { namespace, name });
  } catch (err: any) {
    if (is404(err)) {
      await coreApi.createNamespacedConfigMap({ namespace, body });
      log.info("Created ConfigMap", { namespace, name });
    } else {
      throw err;
    }
  }
}

// ── Agent Deployment ────────────────────────────────────────────

export async function applyAgentDeployment(
  namespace: string,
  agentName: string,
  image: string,
  configMapName: string,
  secretName: string,
): Promise<void> {
  const { appsApi } = await getK8sApis();
  const deploymentName = `agent-${agentName}`;

  const deploymentBody = {
    metadata: {
      name: deploymentName,
      namespace,
      labels: { app: deploymentName, "app.kubernetes.io/managed-by": "bionic-platform", "bionic/agent-name": agentName },
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: deploymentName } },
      template: {
        metadata: {
          labels: { app: deploymentName },
          annotations: { "bionic/deployed-at": new Date().toISOString() },
        },
        spec: {
          initContainers: [{
            name: "seed-model-cache",
            image,
            command: ["sh", "-c"],
            args: [
              "mkdir -p /models/hf/hub /models/cache && cp -rn /root/.cache/huggingface/hub/. /models/hf/hub/ 2>/dev/null || true && echo 'model cache seeded:' && ls /models/hf/hub/",
            ],
            volumeMounts: [{ name: "model-cache", mountPath: "/models" }],
            resources: { requests: { cpu: "50m", memory: "64Mi" }, limits: { cpu: "500m", memory: "512Mi" } },
          }],
          containers: [{
            name: "agent",
            image,
            envFrom: [
              { configMapRef: { name: configMapName } },
              { secretRef: { name: secretName, optional: true } },
            ],
            env: [
              // LiveKit SDK reads these exact env var names (uppercase)
              // Vault stores lowercase keys, so we map explicitly
              // Map lowercase Vault keys to uppercase env vars that SDKs expect
              { name: "LIVEKIT_API_KEY", valueFrom: { secretKeyRef: { name: secretName, key: "livekit_api_key", optional: true } } },
              { name: "LIVEKIT_API_SECRET", valueFrom: { secretKeyRef: { name: secretName, key: "livekit_api_secret", optional: true } } },
              { name: "OPENAI_API_KEY", valueFrom: { secretKeyRef: { name: secretName, key: "openai_api_key", optional: true } } },
              { name: "LETTA_API_KEY", valueFrom: { secretKeyRef: { name: secretName, key: "letta_api_key", optional: true } } },
              // Langfuse tracing
              { name: "LANGFUSE_PUBLIC_KEY", valueFrom: { secretKeyRef: { name: secretName, key: "langfuse_public_key", optional: true } } },
              { name: "LANGFUSE_SECRET_KEY", valueFrom: { secretKeyRef: { name: secretName, key: "langfuse_secret_key", optional: true } } },
              // MinIO
              { name: "MINIO_ACCESS_KEY", valueFrom: { secretKeyRef: { name: secretName, key: "minio_access_key", optional: true } } },
              { name: "MINIO_SECRET_KEY", valueFrom: { secretKeyRef: { name: secretName, key: "minio_secret_key", optional: true } } },
              // Shared model cache used by LiveKit turn detector and local model utilities.
              { name: "HF_HOME", value: "/models/hf" },
              { name: "TRANSFORMERS_CACHE", value: "/models/hf" },
              { name: "XDG_CACHE_HOME", value: "/models/cache" },
            ],
            volumeMounts: [{ name: "model-cache", mountPath: "/models" }],
            resources: { requests: { cpu: "250m", memory: "512Mi" }, limits: { cpu: "1000m", memory: "2Gi" } },
          }],
          volumes: [{
            name: "model-cache",
            nfs: { server: AGENT_MODEL_CACHE_NFS_SERVER, path: AGENT_MODEL_CACHE_NFS_PATH },
          }],
        },
      },
    },
  };

  try {
    await appsApi.readNamespacedDeployment({ name: deploymentName, namespace });
    await appsApi.replaceNamespacedDeployment({ name: deploymentName, namespace, body: deploymentBody });
    log.info("Updated agent deployment", { namespace, agentName });
  } catch (err: any) {
    if (is404(err)) {
      await appsApi.createNamespacedDeployment({ namespace, body: deploymentBody });
      log.info("Created agent deployment", { namespace, agentName });
    } else {
      throw err;
    }
  }
}

export async function deleteAgentDeployment(namespace: string, agentName: string): Promise<void> {
  try {
    const { appsApi } = await getK8sApis();
    await appsApi.deleteNamespacedDeployment({ name: `agent-${agentName}`, namespace });
    log.info("Deleted agent deployment", { namespace, agentName });
  } catch (err: any) {
    if (is404(err)) return;
    throw err;
  }
}

export async function getDeploymentStatus(
  namespace: string,
  agentName: string,
): Promise<{ status: string; replicas: number; message: string }> {
  try {
    const { appsApi } = await getK8sApis();
    const result = await appsApi.readNamespacedDeployment({ name: `agent-${agentName}`, namespace });
    const dep = result?.body || result;
    const ready = dep?.status?.readyReplicas || 0;
    const desired = dep?.spec?.replicas || 1;
    const updated = dep?.status?.updatedReplicas || 0;
    const unavailable = dep?.status?.unavailableReplicas || 0;
    const progress = (dep?.status?.conditions || []).find((condition: any) => condition.type === "Progressing");
    if (progress?.status === "False" && progress?.reason === "ProgressDeadlineExceeded") {
      return { status: "failed", replicas: ready, message: `${ready}/${desired} replicas ready; rollout failed` };
    }
    const running = updated >= desired && ready >= desired && unavailable === 0;
    return {
      status: running ? "running" : "deploying",
      replicas: ready,
      message: `${ready}/${desired} replicas ready, ${updated}/${desired} updated`,
    };
  } catch (err: any) {
    if (is404(err)) return { status: "stopped", replicas: 0, message: "Not deployed" };
    return { status: "unknown", replicas: 0, message: String(err) };
  }
}

// ── Dify Deployment ────────────────────────────────────────────

export async function applyDifyDeployment(
  namespace: string,
  manifests: {
    apiDeployment: any;
    workerDeployment: any;
    webDeployment: any;
    sandboxDeployment: any;
    apiService: any;
    webService: any;
    sandboxService: any;
  },
): Promise<void> {
  const { appsApi, coreApi } = await getK8sApis();

  // Apply services first
  for (const svc of [manifests.apiService, manifests.webService, manifests.sandboxService]) {
    try {
      await coreApi.createNamespacedService({ namespace, body: svc });
      log.info("Created Dify service", { namespace, name: svc.metadata.name });
    } catch (err: any) {
      if (is409(err)) {
        await coreApi.replaceNamespacedService({ name: svc.metadata.name, namespace, body: svc });
        log.info("Updated Dify service", { namespace, name: svc.metadata.name });
      } else {
        throw err;
      }
    }
  }

  // Apply deployments
  for (const dep of [manifests.apiDeployment, manifests.workerDeployment, manifests.webDeployment, manifests.sandboxDeployment]) {
    const depName = dep.metadata.name;
    try {
      await appsApi.readNamespacedDeployment({ name: depName, namespace });
      await appsApi.replaceNamespacedDeployment({ name: depName, namespace, body: dep });
      log.info("Updated Dify deployment", { namespace, name: depName });
    } catch (err: any) {
      if (is404(err)) {
        await appsApi.createNamespacedDeployment({ namespace, body: dep });
        log.info("Created Dify deployment", { namespace, name: depName });
      } else {
        throw err;
      }
    }
  }
}

export async function deleteDifyDeployment(namespace: string): Promise<void> {
  const { appsApi, coreApi } = await getK8sApis();

  for (const name of ["dify-api", "dify-worker", "dify-web", "dify-sandbox"]) {
    try {
      await appsApi.deleteNamespacedDeployment({ name, namespace });
      log.info("Deleted Dify deployment", { namespace, name });
    } catch (err: any) {
      if (!is404(err)) log.warn("Failed to delete Dify deployment", { name, error: String(err) });
    }
  }

  for (const name of ["dify-api", "dify-web", "dify-sandbox"]) {
    try {
      await coreApi.deleteNamespacedService({ name, namespace });
    } catch (err: any) {
      if (!is404(err)) log.warn("Failed to delete Dify service", { name, error: String(err) });
    }
  }
}

export async function getDifyStatus(
  namespace: string = "bionic-platform",
): Promise<{ status: string; replicas: number; message: string }> {
  try {
    const { appsApi } = await getK8sApis();
    const result = await appsApi.readNamespacedDeployment({ name: "dify-api", namespace });
    const dep = result?.body || result;
    const ready = dep?.status?.readyReplicas || 0;
    const desired = dep?.spec?.replicas || 1;
    return { status: ready >= desired ? "running" : "deploying", replicas: ready, message: `${ready}/${desired} Dify API replicas ready` };
  } catch (err: any) {
    if (is404(err)) return { status: "not_deployed", replicas: 0, message: "Dify not deployed" };
    return { status: "unknown", replicas: 0, message: String(err) };
  }
}

export const k8s = {
  createNamespace,
  deleteNamespace,
  createResourceQuota,
  createServiceAccount,
  createExternalSecret,
  upsertLivekitKey,
  removeLivekitKey,
  restartLivekitServer,
  applyAgentDeployment,
  deleteAgentDeployment,
  getDeploymentStatus,
  ensureConfigMap,
  applyDifyDeployment,
  deleteDifyDeployment,
  getDifyStatus,
};
