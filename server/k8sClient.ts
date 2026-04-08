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

const LIVEKIT_VAULT_PATH = "t6-apps/livekit/config";
const LIVEKIT_ESO_NAME = "livekit-api-keys";

/**
 * Register a per-app LiveKit api_key/secret with the LiveKit server, the
 * Vault-of-record way: write the fields to Vault under
 * `secret/data/t6-apps/livekit/config` (keys: `${slug}_api_key`,
 * `${slug}_api_secret`), patch the ExternalSecret in the livekit
 * namespace to add data refs + a template line, force-sync ESO so the
 * K8s secret is rebuilt, then restart livekit-server to pick up the
 * new LIVEKIT_KEYS env.
 *
 * Replaces the older direct-K8s-write path which got reverted by ESO
 * within 5 minutes (the source-of-truth drift bug).
 *
 * Idempotent: safe to call multiple times for the same slug.
 */
export async function registerAppLivekitKey(slug: string, apiKey: string, apiSecret: string): Promise<void> {
  const safeSlug = slug.replace(/[^a-z0-9]/g, "_");
  const keyField = `${safeSlug}_api_key`;
  const secretField = `${safeSlug}_api_secret`;

  // 1. Write to Vault, merging with existing fields.
  const { readPlatformVaultPath, writePlatformVaultPath } = await import("./vaultClient.js");
  const existing = (await readPlatformVaultPath(LIVEKIT_VAULT_PATH)) || {};
  existing[keyField] = apiKey;
  existing[secretField] = apiSecret;
  await writePlatformVaultPath(LIVEKIT_VAULT_PATH, existing);
  log.info("Wrote app LiveKit key to Vault", { slug, keyField });

  // 2. Patch the ExternalSecret to add data refs + template line.
  await ensureLivekitEsoFields(slug, keyField, secretField);

  // 3. Force-sync ESO.
  try {
    const { customApi } = await getK8sApis();
    await customApi.patchNamespacedCustomObject({
      group: "external-secrets.io",
      version: "v1beta1",
      namespace: K8S_LIVEKIT_NAMESPACE,
      plural: "externalsecrets",
      name: LIVEKIT_ESO_NAME,
      body: { metadata: { annotations: { "force-sync": String(Date.now()) } } },
      headers: { "Content-Type": "application/merge-patch+json" } as any,
    });
  } catch (err) {
    log.warn("Failed to force-sync ESO (will sync on next interval)", { error: String(err) });
  }
}

/**
 * Patch the livekit-api-keys ExternalSecret to add a (slug_api_key,
 * slug_api_secret) pair to its data references and template lines.
 * Idempotent: skips if the slug is already present.
 */
async function ensureLivekitEsoFields(slug: string, keyField: string, secretField: string): Promise<void> {
  const { customApi } = await getK8sApis();
  let es: any;
  try {
    const res = await customApi.getNamespacedCustomObject({
      group: "external-secrets.io",
      version: "v1beta1",
      namespace: K8S_LIVEKIT_NAMESPACE,
      plural: "externalsecrets",
      name: LIVEKIT_ESO_NAME,
    });
    es = res?.body || res;
  } catch (err) {
    log.warn("LiveKit ExternalSecret not found — skipping template patch", { error: String(err) });
    return;
  }

  const data: any[] = es.spec?.data || [];
  const hasKey = data.some((d) => d.secretKey === keyField);
  if (hasKey) {
    log.info("ExternalSecret already has fields for app", { slug });
    return;
  }
  data.push(
    { remoteRef: { key: LIVEKIT_VAULT_PATH, property: keyField }, secretKey: keyField },
    { remoteRef: { key: LIVEKIT_VAULT_PATH, property: secretField }, secretKey: secretField },
  );

  // Append a template line. Template format is multiline string under
  // spec.target.template.data.LIVEKIT_KEYS.
  const tpl = es.spec?.target?.template?.data?.LIVEKIT_KEYS as string | undefined;
  if (typeof tpl !== "string") {
    log.warn("LiveKit ExternalSecret template missing LIVEKIT_KEYS — skipping template append");
    return;
  }
  const newLine = `{{ .${keyField} }}: {{ .${secretField} }}`;
  if (tpl.includes(newLine)) {
    log.info("Template already contains slug line", { slug });
    return;
  }
  const newTpl = tpl.replace(/\s*$/, "\n") + newLine + "\n";

  const patch = {
    spec: {
      data,
      target: {
        template: {
          data: { LIVEKIT_KEYS: newTpl },
          engineVersion: "v2",
          mergePolicy: "Replace",
        },
      },
    },
  };
  await customApi.patchNamespacedCustomObject({
    group: "external-secrets.io",
    version: "v1beta1",
    namespace: K8S_LIVEKIT_NAMESPACE,
    plural: "externalsecrets",
    name: LIVEKIT_ESO_NAME,
    body: patch,
    headers: { "Content-Type": "application/merge-patch+json" } as any,
  });
  log.info("Patched livekit-api-keys ExternalSecret", { slug });
}

/** @deprecated Direct K8s secret write — gets reverted by ESO. Use registerAppLivekitKey. */
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
            ],
            resources: { requests: { cpu: "250m", memory: "512Mi" }, limits: { cpu: "1000m", memory: "2Gi" } },
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
    return { status: ready >= desired ? "running" : "deploying", replicas: ready, message: `${ready}/${desired} replicas ready` };
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
  registerAppLivekitKey,
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
