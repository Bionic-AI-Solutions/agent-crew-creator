/**
 * App provisioning pipeline.
 * Executes provisioning/deletion step-by-step, persisting status to DB.
 */
import { eq, and, lt } from "drizzle-orm";
import { randomBytes } from "crypto";
import { getDb } from "../db.js";
import { apps, provisioningJobs } from "../../drizzle/platformSchema.js";
import { createLogger } from "../_core/logger.js";
import type { ServiceKey, StepStatus, ProvisioningStep } from "../../shared/provisioningTypes.js";
import { SERVICE_LABELS, DELETE_LABELS } from "../../shared/provisioningTypes.js";

import { keycloakAdmin } from "./keycloakAdmin.js";
import { langfuseAdmin } from "./langfuseAdmin.js";
import { minioAdmin } from "./minioAdmin.js";
import { postgresAdmin } from "./postgresAdmin.js";
import { redisAdmin } from "./redisAdmin.js";
import { lettaAdmin } from "./lettaAdmin.js";
import { buildDifyEnvConfig, buildDifyK8sManifests } from "./difyAdmin.js";
import { vault } from "../vaultClient.js";
import { k8s } from "../k8sClient.js";
import {
  deletePlayerUiARecord,
  ensurePlayerUiARecord,
  getPlayerUiFqdn,
  resolveCloudflareDnsConfig,
  verifyCloudflarePlayerUiARecord,
  waitPublicDnsResolvesToWan,
} from "./cloudflareDns.js";

const log = createLogger("Provisioner");

const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL || "https://platform.baisoln.com";

export interface ProvisionContext {
  appId: number;
  jobId: number;
  slug: string;
  name: string;
  description: string | null;
  enabledServices: ServiceKey[];
  livekitUrl: string;
  roomPrefix: string | null;
}

type StepHandler = (ctx: ProvisionContext, secrets: Record<string, string>) => Promise<Record<string, string>>;

function generateApiKey(slug: string): string {
  return `API${slug.slice(0, 8)}${randomBytes(6).toString("hex")}`;
}

function generateApiSecret(): string {
  return randomBytes(27).toString("base64url");
}

const PROVISION_STEPS: Record<ServiceKey, StepHandler> = {
  livekit: async (ctx, secrets) => {
    const apiKey = generateApiKey(ctx.slug);
    const apiSecret = generateApiSecret();
    const webhookUrl = `${WEBHOOK_BASE_URL}/api/webhooks/${ctx.slug}/livekit`;

    const db = await getDb();
    if (db) {
      await db.update(apps).set({ apiKey, apiSecret, updatedAt: new Date() }).where(eq(apps.id, ctx.appId));
    }

    // Vault-of-record path: writes to Vault, patches the LiveKit
    // ExternalSecret, force-syncs ESO. Replaces the old direct K8s secret
    // write which got reverted by ESO within 5 minutes.
    await k8s.registerAppLivekitKey(ctx.slug, apiKey, apiSecret);
    await k8s.restartLivekitServer();

    const internalLivekitUrl = process.env.LIVEKIT_INTERNAL_URL || "ws://livekit-server.livekit.svc.cluster.local:7880";

    return {
      livekit_api_key: apiKey,
      livekit_api_secret: apiSecret,
      livekit_url: ctx.livekitUrl,
      livekit_internal_url: internalLivekitUrl,
      webhook_url: webhookUrl,
    };
  },

  keycloak: async (ctx) => {
    const { clientId: publicClientId, keycloakId: publicKeycloakId } = await keycloakAdmin.createPublicClient(ctx.slug);
    const { clientId: confClientId, clientSecret, keycloakId: confKeycloakId } = await keycloakAdmin.createConfidentialClient(ctx.slug);
    await keycloakAdmin.createRoles(ctx.slug);
    return {
      keycloak_public_client_id: publicClientId,
      keycloak_public_keycloak_id: publicKeycloakId,
      keycloak_confidential_client_id: confClientId,
      keycloak_confidential_client_secret: clientSecret,
      keycloak_confidential_keycloak_id: confKeycloakId,
      // Aliases for player-ui K8s secret refs
      keycloak_client_secret: clientSecret,
    };
  },

  langfuse: async (ctx) => {
    const { projectId, publicKey, secretKey } = await langfuseAdmin.createProject(ctx.slug);
    return { langfuse_project_id: projectId, langfuse_public_key: publicKey, langfuse_secret_key: secretKey };
  },

  kubernetes: async (ctx) => {
    await k8s.createNamespace(ctx.slug);
    await k8s.createResourceQuota(ctx.slug);
    await k8s.createServiceAccount(ctx.slug);
    return { kubernetes_namespace: ctx.slug, kubernetes_service_account: `${ctx.slug}-sa` };
  },

  postgres: async (ctx) => {
    const { databaseUrl, user, password } = await postgresAdmin.createDatabase(ctx.slug);
    return { postgres_database_url: databaseUrl, postgres_user: user, postgres_password: password };
  },

  redis: async (ctx) => {
    const { redisUrl, keyPrefix } = await redisAdmin.registerKeyPrefix(ctx.slug);
    return { redis_url: redisUrl, redis_key_prefix: keyPrefix };
  },

  minio: async (ctx) => {
    await minioAdmin.createBucket(ctx.slug);
    const { accessKey, secretKey } = await minioAdmin.createServiceAccount(ctx.slug);
    return {
      minio_access_key: accessKey,
      minio_secret_key: secretKey,
      minio_bucket: ctx.slug,
      minio_endpoint: process.env.MINIO_ENDPOINT || "minio-tenant-hl.minio.svc.cluster.local:9000",
    };
  },

  letta: async (ctx) => {
    const { tenantId, mcpUrl } = await lettaAdmin.createTenant(ctx.slug);
    // Include the shared Letta server API key so agents can authenticate
    const lettaApiKey = process.env.LETTA_API_KEY || "";
    return {
      letta_tenant_id: tenantId,
      letta_mcp_url: mcpUrl,
      letta_api_key: lettaApiKey,
    };
  },

  dify: async (ctx, _secrets) => {
    // Dify is a shared platform service in bionic-platform namespace.
    // Per-app provisioning only generates API keys — no per-app Dify deployment.
    const DIFY_NS = "bionic-platform";
    const difySecretKey = generateApiSecret();
    const difyApiKey = generateApiKey(ctx.slug);

    const difyBaseUrl = `http://dify-api.${DIFY_NS}.svc.cluster.local:5001`;
    const difyWebUrl = `http://dify-web.${DIFY_NS}.svc.cluster.local:3000`;

    log.info("Dify configured for app (shared instance)", { slug: ctx.slug, apiUrl: difyBaseUrl });

    return {
      dify_api_key: difyApiKey,
      dify_secret_key: difySecretKey,
      dify_base_url: difyBaseUrl,
      dify_web_url: difyWebUrl,
    };
  },

  vault_policy: async (ctx, secrets) => {
    await vault.writeAppSecret(ctx.slug, secrets);
    await vault.createEsoPolicy(ctx.slug);
    if (ctx.enabledServices.includes("kubernetes")) {
      await k8s.createExternalSecret(ctx.slug);
    }
    return {};
  },

  player_ui: async (ctx) => {
    if (!ctx.enabledServices.includes("kubernetes")) {
      throw new Error("player_ui requires kubernetes (namespace)");
    }
    if (!ctx.enabledServices.includes("livekit")) {
      throw new Error("player_ui requires livekit (API keys in app secret)");
    }
    const { resolvePlayerUiImageRef } = await import("./playerUiDocker.js");
    const image = await resolvePlayerUiImageRef(ctx.slug, {
      slug: ctx.slug,
      name: ctx.name,
      description: ctx.description,
      livekitUrl: ctx.livekitUrl,
    });
    const skipCf = process.env.PLAYER_UI_SKIP_CLOUDFLARE_DNS === "true";
    if (!skipCf) {
      const cf = await resolveCloudflareDnsConfig();
      if (!cf) {
        throw new Error(
          "player_ui requires Cloudflare DNS config (Vault secret/data/shared/cloudflare: api_token, zone_id|zone_ids|zone_name, WAN_IP|wan_ip). " +
            "For dev without DNS, set PLAYER_UI_SKIP_CLOUDFLARE_DNS=true.",
        );
      }
    }
    await ensurePlayerUiARecord(ctx.slug);
    const { host } = await k8s.applyPlayerUi(ctx.slug, image, ctx.livekitUrl);
    log.info("player_ui applied", { slug: ctx.slug, host, image });
    return { player_ui_public_url: `https://${host}`, player_ui_image: image };
  },

  verification: async (ctx, secrets) => {
    const results: Record<string, boolean> = {};
    if (ctx.enabledServices.includes("postgres") && secrets.postgres_database_url) {
      results.postgres = await postgresAdmin.testConnectivity(secrets.postgres_database_url);
    }
    if (ctx.enabledServices.includes("redis") && secrets.redis_url) {
      results.redis = await redisAdmin.testConnectivity(secrets.redis_url, secrets.redis_key_prefix || "");
    }
    const vaultData = await vault.readAppSecret(ctx.slug);
    results.vault = vaultData !== null;

    if (ctx.enabledServices.includes("player_ui") && ctx.enabledServices.includes("kubernetes")) {
      const ready = await k8s.waitPlayerUiReady(ctx.slug, 180_000, 5_000);
      results.player_ui = ready;
      if (!ready) {
        throw new Error(
          "Verification failed: agent player UI (deployment + ingress + in-cluster /api/health) did not become ready within the timeout",
        );
      }
      await k8s.verifyPlayerUiIngressKongRouting(ctx.slug);
      try {
        await k8s.verifyPlayerUiKongHostRoute(ctx.slug);
      } catch (kongErr) {
        // Kong ingress controller can take several minutes to reconcile new Ingress resources.
        // The Ingress spec is already verified correct — Kong will pick it up eventually.
        log.warn("Kong live route check failed (ingress spec is correct — Kong will reconcile)", {
          slug: ctx.slug,
          error: String(kongErr),
        });
      }

      const skipCf = process.env.PLAYER_UI_SKIP_CLOUDFLARE_DNS === "true";
      if (!skipCf) {
        const cf = await resolveCloudflareDnsConfig();
        if (!cf) {
          throw new Error(
            "Verification failed: Cloudflare config missing (required unless PLAYER_UI_SKIP_CLOUDFLARE_DNS=true)",
          );
        }
        await verifyCloudflarePlayerUiARecord(ctx.slug);
        if (!cf.proxied) {
          const fqdn = getPlayerUiFqdn(ctx.slug);
          const dnsOk = await waitPublicDnsResolvesToWan(fqdn, cf.targetIp, 120_000, 5_000);
          if (!dnsOk) {
            throw new Error(
              `Verification failed: public DNS for ${fqdn} did not resolve to WAN ${cf.targetIp} within timeout`,
            );
          }
        } else {
          log.info("Skipping public DNS=WAN check (Cloudflare proxied=true); A record verified via API only", {
            slug: ctx.slug,
          });
        }
      }
    }

    const failures = Object.entries(results).filter(([, ok]) => !ok).map(([name]) => name);
    if (failures.length > 0) {
      log.warn("Verification issues", { slug: ctx.slug, failures });
    }
    return {};
  },
};

const PROVISION_ORDER: ServiceKey[] = [
  "livekit", "keycloak", "langfuse", "kubernetes",
  "postgres", "redis", "minio", "letta", "dify",
  "vault_policy", "player_ui", "verification",
];

/** Rollback handlers — reverse each provisioning step's side effects. */
const ROLLBACK_STEPS: Partial<Record<ServiceKey, (ctx: ProvisionContext, secrets: Record<string, string>) => Promise<void>>> = {
  livekit: async (ctx, secrets) => {
    if (secrets.livekit_api_key) {
      await k8s.removeLivekitKey(secrets.livekit_api_key);
    }
  },
  keycloak: async (ctx) => {
    await keycloakAdmin.deleteClients(ctx.slug);
    await keycloakAdmin.deleteRoles(ctx.slug);
  },
  langfuse: async (_ctx, secrets) => {
    if (secrets.langfuse_project_id) {
      await langfuseAdmin.deleteProject(secrets.langfuse_project_id);
    }
  },
  kubernetes: async (ctx) => {
    await k8s.deleteNamespace(ctx.slug);
  },
  postgres: async (ctx) => {
    await postgresAdmin.dropDatabase(ctx.slug);
  },
  minio: async (ctx) => {
    try { await minioAdmin.deleteServiceAccount(ctx.slug); } catch {}
    try { await minioAdmin.deleteBucket(ctx.slug); } catch {}
  },
  letta: async (ctx) => {
    await lettaAdmin.deleteTenant(ctx.slug);
  },
  vault_policy: async (ctx) => {
    await vault.deleteEsoPolicy(ctx.slug);
    await vault.deleteAppSecret(ctx.slug);
  },
  player_ui: async (ctx) => {
    try { await deletePlayerUiARecord(ctx.slug); } catch {}
    // K8s resources cleaned by kubernetes rollback (namespace delete)
  },
  // redis, dify, verification: no-ops (no external resources to clean)
};

async function updateJobStep(jobId: number, stepName: string, status: StepStatus, error?: string): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const jobs = await db.select().from(provisioningJobs).where(eq(provisioningJobs.id, jobId)).limit(1);
  if (!jobs[0]) return;

  const steps = (jobs[0].steps as ProvisioningStep[]).map((s) => {
    if (s.name === stepName) {
      return {
        ...s,
        status,
        error: error || undefined,
        ...(status === "running" ? { startedAt: new Date().toISOString() } : {}),
        ...(status === "success" || status === "failed" ? { completedAt: new Date().toISOString() } : {}),
      };
    }
    return s;
  });

  await db.update(provisioningJobs).set({
    steps,
    currentStep: status === "running" ? stepName : jobs[0].currentStep,
    updatedAt: new Date(),
  }).where(eq(provisioningJobs.id, jobId));
}

async function updateJobStatus(jobId: number, status: string, error?: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(provisioningJobs).set({
    status,
    error: error || null,
    currentStep: null,
    ...(status === "running" ? { startedAt: new Date() } : {}),
    ...(status === "completed" || status === "failed" ? { completedAt: new Date() } : {}),
    updatedAt: new Date(),
  }).where(eq(provisioningJobs.id, jobId));
}

async function updateAppStatus(appId: number, status: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(apps).set({ provisioningStatus: status, updatedAt: new Date() }).where(eq(apps.id, appId));
}

export async function runProvisioningJob(ctx: ProvisionContext): Promise<void> {
  log.info("Starting provisioning", { slug: ctx.slug, jobId: ctx.jobId });
  await updateJobStatus(ctx.jobId, "running");
  await updateAppStatus(ctx.appId, "provisioning");

  const secrets: Record<string, string> = {};
  const completedSteps: ServiceKey[] = [];

  for (const stepName of PROVISION_ORDER) {
    const isEnabled = ctx.enabledServices.includes(stepName);
    const alwaysRun = stepName === "vault_policy" || stepName === "verification";

    if (!isEnabled && !alwaysRun) {
      await updateJobStep(ctx.jobId, stepName, "skipped");
      continue;
    }

    await updateJobStep(ctx.jobId, stepName, "running");

    try {
      const handler = PROVISION_STEPS[stepName];
      const newSecrets = await handler(ctx, secrets);
      Object.assign(secrets, newSecrets);
      completedSteps.push(stepName);
      await updateJobStep(ctx.jobId, stepName, "success");
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error(`Step failed: ${stepName}`, { slug: ctx.slug, error: errorMsg });
      await updateJobStep(ctx.jobId, stepName, "failed", errorMsg);

      // Rollback completed steps in reverse order
      log.info("Rolling back completed steps", { slug: ctx.slug, steps: completedSteps });
      for (const completed of [...completedSteps].reverse()) {
        const rollbackFn = ROLLBACK_STEPS[completed];
        if (rollbackFn) {
          try {
            await rollbackFn(ctx, secrets);
            await updateJobStep(ctx.jobId, completed, "rolled_back" as StepStatus);
            log.info(`Rolled back: ${completed}`, { slug: ctx.slug });
          } catch (rbErr) {
            log.warn(`Rollback failed: ${completed}`, { slug: ctx.slug, error: String(rbErr) });
          }
        }
      }

      await updateJobStatus(ctx.jobId, "failed", errorMsg);
      await updateAppStatus(ctx.appId, "failed");
      return;
    }
  }

  await updateJobStatus(ctx.jobId, "completed");
  await updateAppStatus(ctx.appId, "completed");
  log.info("Provisioning complete", { slug: ctx.slug });
}

export async function retryProvisioningJob(jobId: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const jobs = await db.select().from(provisioningJobs).where(eq(provisioningJobs.id, jobId)).limit(1);
  const job = jobs[0];
  if (!job) throw new Error("Job not found");
  if (job.status !== "failed") throw new Error("Can only retry failed jobs");

  const appRows = await db.select().from(apps).where(eq(apps.id, job.appId)).limit(1);
  const app = appRows[0];
  if (!app) throw new Error("App not found");

  // Reset failed steps to pending
  const steps = job.steps as ProvisioningStep[];
  let foundFailed = false;
  for (const step of steps) {
    if (step.status === "failed") foundFailed = true;
    if (foundFailed) {
      step.status = "pending";
      step.error = undefined;
    }
  }

  await db.update(provisioningJobs).set({ steps, status: "running", error: null, updatedAt: new Date() })
    .where(eq(provisioningJobs.id, jobId));

  const ctx: ProvisionContext = {
    appId: app.id, jobId, slug: app.slug, name: app.name,
    description: app.description, enabledServices: app.enabledServices as ServiceKey[],
    livekitUrl: app.livekitUrl, roomPrefix: app.roomPrefix,
  };

  const existingSecrets = (await vault.readAppSecret(app.slug)) || {};
  const secrets: Record<string, string> = { ...existingSecrets };

  for (const step of steps) {
    if (step.status !== "pending") continue;
    const stepName = step.name as ServiceKey;
    const isEnabled = ctx.enabledServices.includes(stepName);
    const alwaysRun = stepName === "vault_policy" || stepName === "verification";

    if (!isEnabled && !alwaysRun) { await updateJobStep(jobId, stepName, "skipped"); continue; }
    await updateJobStep(jobId, stepName, "running");

    try {
      const handler = PROVISION_STEPS[stepName];
      Object.assign(secrets, await handler(ctx, secrets));
      await updateJobStep(jobId, stepName, "success");
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await updateJobStep(jobId, stepName, "failed", errorMsg);
      await updateJobStatus(jobId, "failed", errorMsg);
      await updateAppStatus(ctx.appId, "failed");
      return;
    }
  }

  await updateJobStatus(jobId, "completed");
  await updateAppStatus(ctx.appId, "completed");
}

export async function runDeletionJob(appId: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const appRows = await db.select().from(apps).where(eq(apps.id, appId)).limit(1);
  const app = appRows[0];
  if (!app) throw new Error("App not found");

  const enabledServices = app.enabledServices as ServiceKey[];
  const secrets = (await vault.readAppSecret(app.slug)) || {};

  await updateAppStatus(appId, "deleting");

  const errors: string[] = [];
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      log.info(`Deletion step completed: ${name}`, { slug: app.slug });
    } catch (err) {
      const msg = `${name}: ${err instanceof Error ? err.message : String(err)}`;
      log.error(`Deletion step failed: ${name}`, { slug: app.slug, error: msg });
      errors.push(msg);
    }
  };

  // 0. Dify — delete crew engine
  if (enabledServices.includes("dify")) {
    await step("dify-engine", () => k8s.deleteDifyDeployment(app.slug));
  }

  // 1. Letta — delete tenant agents
  if (enabledServices.includes("letta")) {
    await step("letta-agents", () => lettaAdmin.deleteTenant(app.slug));
  }

  // 2. Keycloak — delete clients AND roles
  if (enabledServices.includes("keycloak")) {
    await step("keycloak-clients", () => keycloakAdmin.deleteClients(app.slug));
    await step("keycloak-roles", () => keycloakAdmin.deleteRoles(app.slug));
  }

  // 3. Langfuse — delete project and API keys
  if (enabledServices.includes("langfuse") && secrets.langfuse_project_id) {
    await step("langfuse-project", () => langfuseAdmin.deleteProject(secrets.langfuse_project_id));
  }

  // 4. PostgreSQL — drop per-app database and role
  if (enabledServices.includes("postgres")) {
    await step("postgres-database", () => postgresAdmin.dropDatabase(app.slug));
  }

  // 5. MinIO — delete service account, policy, then bucket
  if (enabledServices.includes("minio")) {
    await step("minio-service-account", () => minioAdmin.deleteServiceAccount(app.slug));
    await step("minio-bucket", () => minioAdmin.deleteBucket(app.slug));
  }

  // 6. LiveKit — remove API key from Vault, ESO template, and K8s secret
  if (enabledServices.includes("livekit") && secrets.livekit_api_key) {
    await step("livekit-key", async () => {
      const safeSlug = app.slug.replace(/[^a-z0-9]/g, "_");
      const keyField = `${safeSlug}_api_key`;
      const secretField = `${safeSlug}_api_secret`;

      // Remove from Vault shared LiveKit config
      try {
        const { readPlatformVaultPath, writePlatformVaultPath } = await import("../vaultClient.js");
        const existing = (await readPlatformVaultPath("t6-apps/livekit/config")) || {};
        delete existing[keyField];
        delete existing[secretField];
        await writePlatformVaultPath("t6-apps/livekit/config", existing);
        log.info("Removed LiveKit key from Vault", { slug: app.slug });
      } catch (err) {
        log.warn("Failed to remove LiveKit key from Vault (non-fatal)", { error: String(err) });
      }

      // Remove from K8s secret directly (immediate effect)
      await k8s.removeLivekitKey(secrets.livekit_api_key);
      await k8s.restartLivekitServer();
    });
  }

  // 7. Cloudflare — remove player UI A record before namespace teardown
  if (enabledServices.includes("player_ui")) {
    await step("cloudflare-player-ui-dns", () => deletePlayerUiARecord(app.slug));
  }

  // 8. Kubernetes — delete namespace (takes everything in it)
  if (enabledServices.includes("kubernetes")) {
    await step("kubernetes-namespace", () => k8s.deleteNamespace(app.slug));
  }

  // 9. Vault — delete ESO policy and app secrets (always runs)
  await step("vault-policy", () => vault.deleteEsoPolicy(app.slug));
  await step("vault-secrets", () => vault.deleteAppSecret(app.slug));

  // 10. Delete from platform DB — only if all external cleanup succeeded
  if (errors.length > 0) {
    log.warn("Deletion completed with errors — keeping DB record for retry", { slug: app.slug, errors });
    await db
      .update(apps)
      .set({ provisioningStatus: "deletion_partial", updatedAt: new Date() })
      .where(eq(apps.id, appId));
  } else {
    await db.delete(apps).where(eq(apps.id, appId));
    log.info("Deletion complete — all resources removed", { slug: app.slug });
  }
}

// ── Provisioning Watchdog ─────────────────────────────────────
const WATCHDOG_INTERVAL_MS = 60_000; // 1 minute
const STUCK_JOB_TIMEOUT_MS = 30 * 60_000; // 30 minutes

export function startProvisioningWatchdog(): void {
  setInterval(async () => {
    try {
      const db = await getDb();
      if (!db) return;

      const cutoff = new Date(Date.now() - STUCK_JOB_TIMEOUT_MS);
      const stuckJobs = await db
        .select({ id: provisioningJobs.id, appId: provisioningJobs.appId })
        .from(provisioningJobs)
        .where(and(eq(provisioningJobs.status, "running"), lt(provisioningJobs.startedAt, cutoff)));

      for (const job of stuckJobs) {
        log.warn("Watchdog: marking stuck provisioning job as failed", { jobId: job.id, appId: job.appId });
        await db.update(provisioningJobs).set({
          status: "failed",
          error: "Provisioning timed out after 30 minutes (watchdog)",
          completedAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(provisioningJobs.id, job.id));
        await db.update(apps).set({
          provisioningStatus: "failed",
          updatedAt: new Date(),
        }).where(eq(apps.id, job.appId));
      }
    } catch (err) {
      log.error("Watchdog error", { error: String(err) });
    }
  }, WATCHDOG_INTERVAL_MS);
  log.info("Provisioning watchdog started (interval=60s, timeout=30m)");
}
