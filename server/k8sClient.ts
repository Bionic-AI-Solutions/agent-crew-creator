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

// Cluster-wide shared model cache for every agent pod across every app
// namespace. Mounted as an `nfs` volume directly in the Pod spec (not via
// PVC) because PVCs are namespace-scoped and a single PV can only bind to
// one PVC at a time — the only way to share one filesystem path across
// every namespace is to mount NFS straight into the Pod.
//
// All agent pods in all apps point at the same NFS path, so HuggingFace
// model downloads, livekit plugin assets, etc. are downloaded once and
// reused everywhere. The Dockerfile still pre-bakes models for cold-start.
const MODEL_CACHE_NFS_SERVER = process.env.MODEL_CACHE_NFS_SERVER || "192.168.0.109";
const MODEL_CACHE_NFS_PATH = process.env.MODEL_CACHE_NFS_PATH || "/volume1/docker/bionic-shared/agent-models";

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
let _k8sNetworkingApi: any = null;

async function getK8sApis() {
  if (_k8sApi) {
    return {
      coreApi: _k8sApi,
      appsApi: _k8sAppsApi,
      customApi: _k8sCustomApi,
      networkingApi: _k8sNetworkingApi,
    };
  }

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
  _k8sNetworkingApi = kc.makeApiClient(k8s.NetworkingV1Api);
  return {
    coreApi: _k8sApi,
    appsApi: _k8sAppsApi,
    customApi: _k8sCustomApi,
    networkingApi: _k8sNetworkingApi,
  };
}

/**
 * Send an application/merge-patch+json PATCH to the K8s API.
 * The @kubernetes/client-node patchNamespacedCustomObject defaults to
 * json-patch (array-of-ops) which K8s rejects for CRDs. This helper
 * uses the in-cluster service account token and CA cert directly.
 */
async function k8sMergePatch(path: string, body: unknown): Promise<void> {
  const fs = await import("fs");
  const https = await import("https");
  const SA_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";
  const SA_CA_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";

  let server: string;
  let token: string;
  let ca: Buffer | undefined;

  // In-cluster
  if (fs.existsSync(SA_TOKEN_PATH)) {
    server = `https://${process.env.KUBERNETES_SERVICE_HOST || "kubernetes.default.svc"}:${process.env.KUBERNETES_SERVICE_PORT || "443"}`;
    token = fs.readFileSync(SA_TOKEN_PATH, "utf8").trim();
    ca = fs.existsSync(SA_CA_PATH) ? fs.readFileSync(SA_CA_PATH) : undefined;
  } else {
    // Fallback: use kubeconfig
    const k8s = await import("@kubernetes/client-node");
    const kc = new k8s.KubeConfig();
    if (process.env.KUBECONFIG) { kc.loadFromFile(process.env.KUBECONFIG); }
    else { kc.loadFromDefault(); }
    const cluster = kc.getCurrentCluster();
    const user = kc.getCurrentUser();
    server = cluster?.server || "https://kubernetes.default.svc";
    token = user?.token || "";
  }

  return new Promise((resolve, reject) => {
    const url = new URL(path, server);
    const payload = JSON.stringify(body);
    const opts: import("https").RequestOptions = {
      method: "PATCH",
      hostname: url.hostname,
      port: url.port || "443",
      path: url.pathname,
      headers: {
        "Content-Type": "application/merge-patch+json",
        "Authorization": `Bearer ${token}`,
        "Content-Length": Buffer.byteLength(payload),
      },
      // Always verify TLS. In-cluster: CA cert is at /var/run/secrets/.../ca.crt.
      // Out-of-cluster: rely on system CA bundle. Never disable verification.
      ...(ca ? { ca } : {}),
    };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk: string) => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`K8s merge-patch ${path} failed (${res.statusCode}): ${data.slice(0, 300)}`));
        }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
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

  // 1. Write to Vault with CAS (check-and-set) to prevent race conditions
  //    when multiple apps are provisioned concurrently.
  const { readPlatformVaultPathWithVersion, writePlatformVaultPath } = await import("./vaultClient.js");
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const result = await readPlatformVaultPathWithVersion(LIVEKIT_VAULT_PATH);
    const existing = result?.data || {};
    const version = result?.version ?? 0;
    existing[keyField] = apiKey;
    existing[secretField] = apiSecret;
    try {
      await writePlatformVaultPath(LIVEKIT_VAULT_PATH, existing, version);
      log.info("Wrote app LiveKit key to Vault (CAS)", { slug, keyField, version, attempt });
      break;
    } catch (casErr: any) {
      if (attempt < maxRetries - 1 && String(casErr).includes("check-and-set")) {
        log.warn("Vault CAS conflict, retrying", { slug, attempt });
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      throw casErr;
    }
  }

  // 2. Patch the ExternalSecret to add data refs + template line.
  await ensureLivekitEsoFields(slug, keyField, secretField);

  // 3. Force-sync ESO via annotation.
  try {
    await k8sMergePatch(
      `/apis/external-secrets.io/v1/namespaces/${K8S_LIVEKIT_NAMESPACE}/externalsecrets/${LIVEKIT_ESO_NAME}`,
      { metadata: { annotations: { "force-sync": String(Date.now()) } } },
    );
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
      version: "v1",
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
  // Use raw https request with merge-patch content type — the K8s JS
  // client's patchNamespacedCustomObject defaults to json-patch which fails.
  await k8sMergePatch(
    `/apis/external-secrets.io/v1/namespaces/${K8S_LIVEKIT_NAMESPACE}/externalsecrets/${LIVEKIT_ESO_NAME}`,
    patch,
  );
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
  /** Extra plain env vars (no secret refs). Used for per-agent provider
   *  API keys read from Vault at deploy time — see agentDeployer.ts. */
  extraEnv: Array<{ name: string; value: string }> = [],
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
          // Seed the shared NFS model cache with whatever the agent image
          // baked in (turn-detector ONNX, languages.json, silero VAD, etc.)
          // — `cp -rn` is no-clobber so concurrent pods don't fight, and
          // the destination is shared across all apps so this is a one-time
          // copy per cluster, not per pod.
          initContainers: [{
            name: "seed-model-cache",
            image,
            command: ["sh", "-c",
              "mkdir -p /models/hf/hub /models/cache && " +
              "cp -rn /root/.cache/huggingface/hub/. /models/hf/hub/ 2>/dev/null || true && " +
              "echo 'model cache seeded:' && ls /models/hf/hub/"],
            volumeMounts: [{ name: "model-cache", mountPath: "/models" }],
            // Quotas in app namespaces require explicit resources on every container.
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
              // Point HuggingFace + livekit-agents caches at the shared PVC
              { name: "HF_HOME", value: "/models/hf" },
              { name: "TRANSFORMERS_CACHE", value: "/models/hf" },
              { name: "XDG_CACHE_HOME", value: "/models/cache" },
              // Per-agent provider API keys passed in from agentDeployer.
              ...extraEnv,
            ],
            volumeMounts: [
              { name: "model-cache", mountPath: "/models" },
            ],
            resources: { requests: { cpu: "250m", memory: "512Mi" }, limits: { cpu: "1000m", memory: "2Gi" } },
          }],
          volumes: [
            // Cluster-wide shared model cache via direct NFS mount.
            // Same path on the NFS server is mounted into every agent pod
            // in every app namespace, so HF models / livekit assets are
            // downloaded once and shared across the entire platform.
            {
              name: "model-cache",
              nfs: { server: MODEL_CACHE_NFS_SERVER, path: MODEL_CACHE_NFS_PATH },
            },
          ],
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
    const unavailable = dep?.status?.unavailableReplicas;
    const conds = (dep?.status?.conditions || []).map((c: any) => ({
      t: c?.type,
      st: c?.status,
      reason: c?.reason,
    }));
    // #region agent log
    const { emitDebugLog } = await import("./debugSessionLog.js");
    emitDebugLog({
      location: "k8sClient.ts:getDeploymentStatus",
      message: "readNamespacedDeployment result",
      hypothesisId: "H1",
      data: {
        namespace,
        deployment: `agent-${agentName}`,
        ready,
        desired,
        unavailable: unavailable ?? null,
        conditionSummary: conds.slice(0, 4),
      },
    });
    // #endregion
    return { status: ready >= desired ? "running" : "deploying", replicas: ready, message: `${ready}/${desired} replicas ready` };
  } catch (err: any) {
    // #region agent log
    const { emitDebugLog } = await import("./debugSessionLog.js");
    emitDebugLog({
      location: "k8sClient.ts:getDeploymentStatus",
      message: is404(err) ? "deployment404" : "deployment read error",
      hypothesisId: "H2",
      data: { namespace, deployment: `agent-${agentName}`, errCode: err?.code, is404: is404(err) },
    });
    // #endregion
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

// ── Agent Player UI (per-app Next.js voice client) ─────────────

const PLAYER_UI_DEPLOYMENT = "player-ui";
const PLAYER_UI_SERVICE = "player-ui";
const PLAYER_UI_INGRESS = "player-ui";
const PLAYER_UI_CONTAINER_PORT = 3000;

function playerUiHost(slug: string): string {
  const suffix = (process.env.PLAYER_UI_HOST_SUFFIX || "baisoln.com").replace(/^\.+/, "");
  return `${slug}.${suffix}`;
}

/**
 * Deploy player UI Deployment + Service + Ingress into the app namespace.
 * Expects ExternalSecret `{namespace}-secrets` (after vault_policy) for LiveKit keys.
 */
export async function applyPlayerUi(
  namespace: string,
  image: string,
  livekitPublicUrl: string,
): Promise<{ host: string }> {
  const { appsApi, coreApi, networkingApi } = await getK8sApis();
  const host = playerUiHost(namespace);
  const ingressClass = process.env.PLAYER_UI_INGRESS_CLASS || "kong";
  const certIssuer = process.env.PLAYER_UI_CERT_ISSUER?.trim();
  const tlsSecretName = process.env.PLAYER_UI_TLS_SECRET?.trim() || `${namespace}-player-ui-tls`;

  const secretName = `${namespace}-secrets`;

  const deploymentBody = {
    metadata: {
      name: PLAYER_UI_DEPLOYMENT,
      namespace,
      labels: { app: PLAYER_UI_DEPLOYMENT, "app.kubernetes.io/managed-by": "bionic-platform" },
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: PLAYER_UI_DEPLOYMENT } },
      template: {
        metadata: {
          labels: { app: PLAYER_UI_DEPLOYMENT },
          annotations: { "bionic/deployed-at": new Date().toISOString() },
        },
        spec: {
          containers: [{
            name: "player-ui",
            image,
            imagePullPolicy: process.env.PLAYER_UI_IMAGE_PULL_POLICY || "Always",
            ports: [{ containerPort: PLAYER_UI_CONTAINER_PORT, name: "http" }],
            env: [
              { name: "NEXT_PUBLIC_LIVEKIT_URL", value: livekitPublicUrl },
              { name: "PORT", value: String(PLAYER_UI_CONTAINER_PORT) },
              { name: "HOSTNAME", value: "0.0.0.0" },
              { name: "APP_SLUG", value: namespace },
              { name: "NEXTAUTH_URL", value: `https://${host}` },
              {
                name: "NEXTAUTH_SECRET",
                valueFrom: { secretKeyRef: { name: secretName, key: "keycloak_client_secret", optional: true } },
              },
              {
                name: "KEYCLOAK_ISSUER",
                value: `${process.env.KEYCLOAK_URL || "https://auth.bionicaisolutions.com"}/realms/${process.env.KEYCLOAK_REALM || "Bionic"}`,
              },
              {
                name: "KEYCLOAK_CLIENT_ID",
                valueFrom: { secretKeyRef: { name: secretName, key: "keycloak_confidential_client_id", optional: true } },
              },
              {
                name: "KEYCLOAK_CLIENT_SECRET",
                valueFrom: { secretKeyRef: { name: secretName, key: "keycloak_client_secret", optional: true } },
              },
              {
                name: "PLATFORM_API_URL",
                value: `http://bionic-platform.bionic-platform.svc.cluster.local:80`,
              },
              {
                name: "PLAYER_UI_INTERNAL_TOKEN",
                value: process.env.PLAYER_UI_INTERNAL_TOKEN || "",
              },
              {
                name: "LIVEKIT_URL",
                valueFrom: { secretKeyRef: { name: secretName, key: "livekit_url" } },
              },
              {
                name: "LIVEKIT_API_KEY",
                valueFrom: { secretKeyRef: { name: secretName, key: "livekit_api_key" } },
              },
              {
                name: "LIVEKIT_API_SECRET",
                valueFrom: { secretKeyRef: { name: secretName, key: "livekit_api_secret" } },
              },
            ],
            readinessProbe: {
              httpGet: { path: "/api/health", port: PLAYER_UI_CONTAINER_PORT },
              initialDelaySeconds: 5,
              periodSeconds: 10,
              timeoutSeconds: 5,
              failureThreshold: 6,
            },
            livenessProbe: {
              httpGet: { path: "/api/health", port: PLAYER_UI_CONTAINER_PORT },
              initialDelaySeconds: 15,
              periodSeconds: 20,
              timeoutSeconds: 5,
            },
            resources: {
              requests: { cpu: "100m", memory: "256Mi" },
              limits: { cpu: "500m", memory: "512Mi" },
            },
          }],
        },
      },
    },
  };

  try {
    await appsApi.readNamespacedDeployment({ name: PLAYER_UI_DEPLOYMENT, namespace });
    await appsApi.replaceNamespacedDeployment({ name: PLAYER_UI_DEPLOYMENT, namespace, body: deploymentBody });
    log.info("Updated player-ui deployment", { namespace });
  } catch (err: any) {
    if (is404(err)) {
      await appsApi.createNamespacedDeployment({ namespace, body: deploymentBody });
      log.info("Created player-ui deployment", { namespace });
    } else {
      throw err;
    }
  }

  const serviceBody = {
    metadata: {
      name: PLAYER_UI_SERVICE,
      namespace,
      labels: { app: PLAYER_UI_DEPLOYMENT, "app.kubernetes.io/managed-by": "bionic-platform" },
    },
    spec: {
      selector: { app: PLAYER_UI_DEPLOYMENT },
      ports: [{ port: 80, targetPort: PLAYER_UI_CONTAINER_PORT, name: "http" }],
      type: "ClusterIP",
    },
  };

  try {
    await coreApi.readNamespacedService({ name: PLAYER_UI_SERVICE, namespace });
    await coreApi.replaceNamespacedService({ name: PLAYER_UI_SERVICE, namespace, body: serviceBody });
    log.info("Updated player-ui service", { namespace });
  } catch (err: any) {
    if (is404(err)) {
      await coreApi.createNamespacedService({ namespace, body: serviceBody });
      log.info("Created player-ui service", { namespace });
    } else {
      throw err;
    }
  }

  const useTls = Boolean(certIssuer || process.env.PLAYER_UI_TLS_SECRET?.trim());

  const annotations: Record<string, string> = {
    "konghq.com/protocols": "http,https",
    "konghq.com/preserve-host": "true",
    "konghq.com/strip-path": "false",
    "konghq.com/websocket-support": "true",
  };
  if (useTls) {
    annotations["konghq.com/ssl-redirect"] = "true";
  }
  if (certIssuer) {
    annotations["cert-manager.io/cluster-issuer"] = certIssuer;
  }

  const ingressSpec: any = {
    ingressClassName: ingressClass,
    rules: [{
      host,
      http: {
        paths: [{
          path: "/",
          pathType: "Prefix",
          backend: {
            service: { name: PLAYER_UI_SERVICE, port: { number: 80 } },
          },
        }],
      },
    }],
  };

  if (useTls) {
    ingressSpec.tls = [{ hosts: [host], secretName: tlsSecretName }];
  }

  const ingressBody = {
    metadata: {
      name: PLAYER_UI_INGRESS,
      namespace,
      labels: { app: PLAYER_UI_DEPLOYMENT, "app.kubernetes.io/managed-by": "bionic-platform" },
      annotations,
    },
    spec: ingressSpec,
  };

  try {
    await networkingApi.readNamespacedIngress({ name: PLAYER_UI_INGRESS, namespace });
    await networkingApi.replaceNamespacedIngress({ name: PLAYER_UI_INGRESS, namespace, body: ingressBody });
    log.info("Updated player-ui ingress", { namespace, host });
  } catch (err: any) {
    if (is404(err)) {
      await networkingApi.createNamespacedIngress({ namespace, body: ingressBody });
      log.info("Created player-ui ingress", { namespace, host });
    } else {
      throw err;
    }
  }

  return { host };
}

export async function getPlayerUiDeploymentStatus(
  namespace: string,
): Promise<{ status: string; replicas: number; message: string }> {
  try {
    const { appsApi } = await getK8sApis();
    const result = await appsApi.readNamespacedDeployment({ name: PLAYER_UI_DEPLOYMENT, namespace });
    const dep = result?.body || result;
    const ready = dep?.status?.readyReplicas || 0;
    const desired = dep?.spec?.replicas || 1;
    return {
      status: ready >= desired ? "running" : "deploying",
      replicas: ready,
      message: `${ready}/${desired} player-ui replicas ready`,
    };
  } catch (err: any) {
    if (is404(err)) return { status: "missing", replicas: 0, message: "player-ui deployment not found" };
    return { status: "unknown", replicas: 0, message: String(err) };
  }
}

export async function playerUiIngressExists(namespace: string): Promise<boolean> {
  try {
    const { networkingApi } = await getK8sApis();
    await networkingApi.readNamespacedIngress({ name: PLAYER_UI_INGRESS, namespace });
    return true;
  } catch (err: any) {
    if (is404(err)) return false;
    log.warn("player-ui ingress read failed", { namespace, error: String(err) });
    return false;
  }
}

function playerUiHealthBodyLooksOk(body: unknown): boolean {
  // @kubernetes/client-node deserializes JSON proxy bodies as objects even when the API types them as string.
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const ok = (body as { ok?: unknown }).ok;
    if (ok === true) return true;
  }
  const text = typeof body === "string" ? body : JSON.stringify(body);
  if (text.includes('"ok"') && text.includes("true")) return true;
  try {
    const j = JSON.parse(text) as { ok?: boolean };
    return j?.ok === true;
  } catch {
    return false;
  }
}

/**
 * GET /api/health via Kubernetes API service or pod proxy (in-cluster; no public ingress needed).
 */
export async function checkPlayerUiPodHealth(namespace: string): Promise<boolean> {
  const { coreApi } = await getK8sApis();

  const serviceProxyNames = [
    `http:${PLAYER_UI_SERVICE}:80`,
    `http:${PLAYER_UI_SERVICE}:http`,
  ];

  for (const svcName of serviceProxyNames) {
    try {
      const body = await coreApi.connectGetNamespacedServiceProxyWithPath({
        namespace,
        name: svcName,
        path: "api/health",
      });
      if (playerUiHealthBodyLooksOk(body)) return true;
    } catch (err: any) {
      log.info("player-ui service proxy health attempt failed", { namespace, svcName, err: String(err?.body?.message || err) });
    }
  }

  try {
    const res = await coreApi.listNamespacedPod({
      namespace,
      labelSelector: `app=${PLAYER_UI_DEPLOYMENT}`,
    });
    const list = res?.body ?? res;
    const items: any[] = list?.items ?? [];
    const running = items.find((p) => p?.status?.phase === "Running");
    const podName = running?.metadata?.name;
    if (!podName) return false;

    const body = await coreApi.connectGetNamespacedPodProxyWithPath({
      namespace,
      name: `${podName}:${PLAYER_UI_CONTAINER_PORT}`,
      path: "api/health",
    });
    return playerUiHealthBodyLooksOk(body);
  } catch (err: any) {
    log.warn("player-ui /api/health via pod proxy failed", { namespace, error: String(err?.body?.message || err) });
    return false;
  }
}

/**
 * Wait until player-ui Deployment + Ingress are ready and `/api/health` succeeds in-cluster.
 */
export async function waitPlayerUiReady(
  namespace: string,
  timeoutMs = 180_000,
  intervalMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const dep = await getPlayerUiDeploymentStatus(namespace);
    const ing = await playerUiIngressExists(namespace);
    if (dep.status === "running" && ing) {
      const healthy = await checkPlayerUiPodHealth(namespace);
      if (healthy) {
        log.info("player-ui verified ready (deployment + ingress + /api/health)", { namespace });
        return true;
      }
      log.info("player-ui deployment up but /api/health not OK yet", { namespace });
    } else {
      log.info("player-ui not ready yet", { namespace, dep: dep.message, ingress: ing });
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * Ingress spec: Kong class, host = {slug}.{suffix}, backend Service player-ui:80.
 */
export async function verifyPlayerUiIngressKongRouting(namespace: string): Promise<void> {
  const expectedHost = playerUiHost(namespace);
  const expectedClass = process.env.PLAYER_UI_INGRESS_CLASS || "kong";
  const { networkingApi } = await getK8sApis();
  const res = await networkingApi.readNamespacedIngress({ name: PLAYER_UI_INGRESS, namespace });
  const ing = (res as { body?: unknown })?.body ?? res;
  const spec = (ing as { spec?: Record<string, unknown> })?.spec as
    | {
        ingressClassName?: string;
        rules?: Array<{
          host?: string;
          http?: { paths?: Array<{ backend?: { service?: { name?: string; port?: { number?: number } } } }> };
        }>;
      }
    | undefined;
  if (!spec) throw new Error("verifyPlayerUiIngressKongRouting: player-ui ingress has no spec");
  if (spec.ingressClassName !== expectedClass) {
    throw new Error(
      `verifyPlayerUiIngressKongRouting: ingressClassName want "${expectedClass}" got "${spec.ingressClassName}"`,
    );
  }
  const rule = spec.rules?.[0];
  if (!rule?.host || rule.host !== expectedHost) {
    throw new Error(`verifyPlayerUiIngressKongRouting: rule host want ${expectedHost} got ${rule?.host}`);
  }
  const path = rule.http?.paths?.[0];
  const svcName = path?.backend?.service?.name;
  const portNum = path?.backend?.service?.port?.number;
  if (svcName !== PLAYER_UI_SERVICE) {
    throw new Error(`verifyPlayerUiIngressKongRouting: backend service want ${PLAYER_UI_SERVICE} got ${svcName}`);
  }
  if (portNum !== 80) {
    throw new Error(`verifyPlayerUiIngressKongRouting: backend port want 80 got ${portNum}`);
  }
  log.info("player-ui ingress spec verified (Kong → player-ui:80)", { namespace, host: expectedHost });
}

/**
 * Hit Kong's proxy with the app's public Host header (in-cluster). Confirms Kong → Ingress → Service chain.
 * Set PLAYER_UI_KONG_VERIFY_URL if your Kong proxy base URL differs (default: http://kong-kong-proxy.kong.svc.cluster.local:80).
 */
export async function verifyPlayerUiKongHostRoute(namespace: string): Promise<void> {
  const publicHost = playerUiHost(namespace);
  const baseRaw =
    process.env.PLAYER_UI_KONG_VERIFY_URL?.trim() || "http://kong-kong-proxy.kong.svc.cluster.local:80";
  const base = baseRaw.replace(/\/$/, "");
  const url = `${base}/api/health`;
  const attempts = 24;
  const pauseMs = 10_000;
  let lastErr = "";
  // Kong ingress controller takes 1-3 minutes to reconcile new Ingress resources
  log.info("Waiting for Kong ingress controller to reconcile (30s initial delay)", { namespace, publicHost });
  await new Promise((r) => setTimeout(r, 30_000));
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { Host: publicHost, Accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`;
      } else {
        const body = await res.json();
        const ok = body !== null && typeof body === "object" && (body as { ok?: boolean }).ok === true;
        if (ok) {
          log.info("Verified player UI /api/health via Kong with app Host header", { namespace, publicHost });
          return;
        }
        lastErr = "health body not ok";
      }
    } catch (e) {
      lastErr = String(e);
    }
    if (i < attempts - 1) {
      log.info("Kong route verify retry", { namespace, publicHost, attempt: i + 1, lastErr });
      await new Promise((r) => setTimeout(r, pauseMs));
    }
  }
  throw new Error(`Kong route verify failed after ${attempts} attempts: GET ${url} Host ${publicHost} — ${lastErr}`);
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
  applyPlayerUi,
  waitPlayerUiReady,
  getPlayerUiDeploymentStatus,
  playerUiIngressExists,
  checkPlayerUiPodHealth,
  verifyPlayerUiIngressKongRouting,
  verifyPlayerUiKongHostRoute,
};
