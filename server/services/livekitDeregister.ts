/**
 * Single source of truth for removing an app's LiveKit API key from EVERYWHERE
 * it lives: the shared Vault config, the ESO template that rebuilds the K8s
 * Secret, and the live K8s Secret itself.
 *
 * This exists because rollback of a failed provisioning job previously only
 * edited the live K8s Secret (k8s.removeLivekitKey) — a path the code marks
 * @deprecated precisely because ESO reconciles the Secret back from Vault +
 * the ESO template. Leaving the Vault key and template line in place meant the
 * "rolled back" key was resurrected on ESO's next sync. Both the rollback and
 * the app-deletion job now call deregisterAppLivekitKey so they stay in sync.
 */
import { createLogger } from "../_core/logger.js";
import { k8s } from "../k8sClient.js";

const log = createLogger("LivekitDeregister");

const LIVEKIT_VAULT_PATH = "t6-apps/livekit/config";

export interface LivekitDeregisterDeps {
  readPlatformVaultPath(path: string): Promise<Record<string, any> | null>;
  writePlatformVaultPath(path: string, data: Record<string, any>): Promise<void>;
  getEso(): Promise<any>;
  putEso(eso: any): Promise<void>;
  removeK8sSecretKey(apiKey: string): Promise<void>;
  restartLivekit(): Promise<void>;
}

/** Convert an app slug to the Vault field-name prefix used for its LiveKit key. */
export function livekitSafeSlug(slug: string): string {
  return slug.replace(/[^a-z0-9]/g, "_");
}

/**
 * Mutate an ESO object in place: drop the app's data refs and template lines.
 * Pure and unit-testable — this is the substance of the resurrection fix.
 */
export function stripLivekitEsoEntries(eso: any, safeSlug: string): any {
  eso.spec.data = (eso.spec?.data || []).filter(
    (d: any) => !d.secretKey?.startsWith(safeSlug),
  );
  const tpl: string = eso.spec?.target?.template?.data?.LIVEKIT_KEYS || "";
  if (eso.spec?.target?.template?.data) {
    eso.spec.target.template.data.LIVEKIT_KEYS = tpl
      .split("\n")
      .filter((l: string) => !l.includes(safeSlug))
      .join("\n");
  }
  return eso;
}

function defaultDeps(): LivekitDeregisterDeps {
  return {
    readPlatformVaultPath: async (path) => {
      const { readPlatformVaultPath } = await import("../vaultClient.js");
      return readPlatformVaultPath(path);
    },
    writePlatformVaultPath: async (path, data) => {
      const { writePlatformVaultPath } = await import("../vaultClient.js");
      await writePlatformVaultPath(path, data);
    },
    getEso: async () => {
      const k8sLib = await import("@kubernetes/client-node");
      const kc = new k8sLib.KubeConfig();
      if (process.env.KUBECONFIG) kc.loadFromFile(process.env.KUBECONFIG);
      else { try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); } }
      const customApi = kc.makeApiClient(k8sLib.CustomObjectsApi);
      const esoRes = await customApi.getNamespacedCustomObject({
        group: "external-secrets.io", version: "v1",
        namespace: "livekit", plural: "externalsecrets", name: "livekit-api-keys",
      });
      return (esoRes as any)?.body || esoRes;
    },
    putEso: async (eso) => {
      const k8sLib = await import("@kubernetes/client-node");
      const kc = new k8sLib.KubeConfig();
      if (process.env.KUBECONFIG) kc.loadFromFile(process.env.KUBECONFIG);
      else { try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); } }
      const customApi = kc.makeApiClient(k8sLib.CustomObjectsApi);
      await customApi.replaceNamespacedCustomObject({
        group: "external-secrets.io", version: "v1",
        namespace: "livekit", plural: "externalsecrets", name: "livekit-api-keys",
        body: eso,
      });
    },
    removeK8sSecretKey: async (apiKey) => { await k8s.removeLivekitKey(apiKey); },
    restartLivekit: async () => { await k8s.restartLivekitServer(); },
  };
}

/**
 * Remove an app's LiveKit key from Vault, the ESO template, and the live K8s
 * Secret. Vault + ESO cleanup are best-effort (logged, non-fatal) so a
 * transient failure in one doesn't block the others; the caller decides
 * whether to surface partial failure.
 */
export async function deregisterAppLivekitKey(
  slug: string,
  livekitApiKey?: string,
  deps: LivekitDeregisterDeps = defaultDeps(),
): Promise<void> {
  const safeSlug = livekitSafeSlug(slug);
  const keyField = `${safeSlug}_api_key`;
  const secretField = `${safeSlug}_api_secret`;

  // 1. Remove from shared Vault LiveKit config (the source of truth ESO reads).
  try {
    const existing = (await deps.readPlatformVaultPath(LIVEKIT_VAULT_PATH)) || {};
    delete existing[keyField];
    delete existing[secretField];
    await deps.writePlatformVaultPath(LIVEKIT_VAULT_PATH, existing);
    log.info("Removed LiveKit key from Vault", { slug });
  } catch (err) {
    log.warn("Failed to remove LiveKit key from Vault (non-fatal)", { slug, error: String(err) });
  }

  // 2. Strip the ESO template (prevents stale refs that break ALL apps' sync).
  try {
    const eso = await deps.getEso();
    stripLivekitEsoEntries(eso, safeSlug);
    await deps.putEso(eso);
    log.info("Removed LiveKit key from ESO template", { slug });
  } catch (err) {
    log.warn("Failed to clean ESO template (non-fatal)", { slug, error: String(err) });
  }

  // 3. Remove from the live K8s Secret for immediate effect (ESO would
  //    otherwise take a reconcile cycle). Only meaningful with a live key.
  if (livekitApiKey) {
    await deps.removeK8sSecretKey(livekitApiKey);
    await deps.restartLivekit();
  }
}
