/**
 * Kubernetes client for managing app namespaces, agent deployments,
 * LiveKit keys, and ExternalSecrets.
 *
 * Uses @kubernetes/client-node v1.4.0 which requires { body: ... } named params.
 */
import { createLogger } from "./_core/logger.js";

const log = createLogger("K8s");

const K8S_LIVEKIT_NAMESPACE = process.env.K8S_LIVEKIT_NAMESPACE || "livekit";
const LIVEKIT_KEYS_SECRET = process.env.LIVEKIT_KEYS_SECRET_NAME || "livekit-api-keys";
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

export async function upsertLivekitKey(apiKey: string, apiSecret: string): Promise<void> {
  try {
    const { coreApi } = await getK8sApis();
    let keysMap: Record<string, string> = {};

    try {
      const secret = await coreApi.readNamespacedSecret({ name: LIVEKIT_KEYS_SECRET, namespace: K8S_LIVEKIT_NAMESPACE });
      const encoded = secret?.body?.data?.LIVEKIT_KEYS || secret?.data?.LIVEKIT_KEYS;
      if (encoded) {
        const raw = Buffer.from(encoded, "base64").toString("utf8");
        for (const line of raw.split("\n")) {
          const idx = line.indexOf(":");
          if (idx > 0) {
            const k = line.slice(0, idx).trim();
            const v = line.slice(idx + 1).trim();
            if (k && v) keysMap[k] = v;
          }
        }
      }
    } catch {}

    keysMap[apiKey] = apiSecret;
    const newValue = Object.entries(keysMap).map(([k, v]) => `${k}: ${v}`).join("\n");

    await coreApi.replaceNamespacedSecret({
      name: LIVEKIT_KEYS_SECRET,
      namespace: K8S_LIVEKIT_NAMESPACE,
      body: {
        metadata: { name: LIVEKIT_KEYS_SECRET },
        data: { LIVEKIT_KEYS: Buffer.from(newValue).toString("base64") },
      },
    });
    log.info("Updated LiveKit keys secret");
  } catch (err) {
    log.warn("Failed to update LiveKit keys", { error: String(err) });
  }
}

export async function removeLivekitKey(apiKey: string): Promise<void> {
  try {
    const { coreApi } = await getK8sApis();
    const secret = await coreApi.readNamespacedSecret({ name: LIVEKIT_KEYS_SECRET, namespace: K8S_LIVEKIT_NAMESPACE });
    const encoded = secret?.body?.data?.LIVEKIT_KEYS || secret?.data?.LIVEKIT_KEYS;
    if (!encoded) return;

    const raw = Buffer.from(encoded, "base64").toString("utf8");
    const lines = raw.split("\n").filter((line: string) => !line.startsWith(`${apiKey}:`));
    const newValue = lines.join("\n");

    await coreApi.replaceNamespacedSecret({
      name: LIVEKIT_KEYS_SECRET,
      namespace: K8S_LIVEKIT_NAMESPACE,
      body: {
        metadata: { name: LIVEKIT_KEYS_SECRET },
        data: { LIVEKIT_KEYS: Buffer.from(newValue).toString("base64") },
      },
    });
    log.info("Removed LiveKit key");
  } catch (err) {
    log.warn("Failed to remove LiveKit key", { error: String(err) });
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
