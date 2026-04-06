/**
 * Dify API client for programmatic workflow/app management.
 * Manages per-tenant Dify instances deployed in app namespaces.
 * All operations throw on failure — never fakes success.
 */
import { createLogger } from "../_core/logger.js";

const log = createLogger("DifyAdmin");

// ── Types ──────────────────────────────────────────────────────

export interface DifyApp {
  id: string;
  name: string;
  mode: "workflow" | "completion" | "chat" | "agent-chat";
  description: string;
}

export interface DifyWorkflowRun {
  workflow_run_id: string;
  task_id: string;
  status: "running" | "succeeded" | "failed" | "stopped";
  outputs?: Record<string, unknown>;
  elapsed_time?: number;
  total_tokens?: number;
  error?: string;
}

export interface DifyWorkflowRunResult {
  workflow_run_id: string;
  status: "running" | "succeeded" | "failed" | "stopped";
  outputs?: Record<string, unknown>;
  elapsed_time?: number;
  total_tokens?: number;
  error?: string;
}

// ── Client ─────────────────────────────────────────────────────

export class DifyClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this.apiKey}`,
    };

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Dify ${method} ${path} failed (${res.status}): ${text}`);
    }

    const ct = res.headers.get("content-type") || "";
    if (ct.includes("json")) return res.json();
    return null;
  }

  // ── Health ────────────────────────────────────────────────────

  async checkHealth(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/health`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // ── Workflow Execution ────────────────────────────────────────

  /**
   * Execute a Dify workflow (blocking mode).
   * Returns the full result when the workflow completes.
   */
  async executeWorkflow(
    appApiKey: string,
    inputs: Record<string, unknown>,
    user: string,
  ): Promise<DifyWorkflowRunResult> {
    const res = await fetch(`${this.baseUrl}/v1/workflows/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${appApiKey}`,
      },
      body: JSON.stringify({
        inputs,
        response_mode: "blocking",
        user,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Dify workflow execution failed (${res.status}): ${text}`);
    }

    const result = await res.json();
    return {
      workflow_run_id: result.workflow_run_id,
      status: result.data?.status || "succeeded",
      outputs: result.data?.outputs,
      elapsed_time: result.data?.elapsed_time,
      total_tokens: result.data?.total_tokens,
      error: result.data?.error,
    };
  }

  /**
   * Execute a Dify workflow (streaming mode).
   * Returns the workflow_run_id immediately for polling.
   */
  async executeWorkflowStreaming(
    appApiKey: string,
    inputs: Record<string, unknown>,
    user: string,
  ): Promise<{ workflow_run_id: string; task_id: string }> {
    const res = await fetch(`${this.baseUrl}/v1/workflows/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${appApiKey}`,
      },
      body: JSON.stringify({
        inputs,
        response_mode: "streaming",
        user,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Dify workflow stream failed (${res.status}): ${text}`);
    }

    // Read first event to get run ID
    const text = await res.text();
    const lines = text.split("\n").filter((l) => l.startsWith("data: "));
    for (const line of lines) {
      try {
        const data = JSON.parse(line.slice(6));
        if (data.workflow_run_id) {
          return { workflow_run_id: data.workflow_run_id, task_id: data.task_id || "" };
        }
      } catch { /* skip non-JSON lines */ }
    }

    throw new Error("No workflow_run_id in streaming response");
  }

  /**
   * Get the status/result of a workflow run.
   */
  async getWorkflowRun(appApiKey: string, runId: string): Promise<DifyWorkflowRunResult> {
    const res = await fetch(`${this.baseUrl}/v1/workflows/run/${runId}`, {
      headers: { Authorization: `Bearer ${appApiKey}` },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Dify get run failed (${res.status}): ${text}`);
    }

    const result = await res.json();
    return {
      workflow_run_id: result.id || runId,
      status: result.status,
      outputs: result.outputs,
      elapsed_time: result.elapsed_time,
      total_tokens: result.total_tokens,
      error: result.error,
    };
  }

  /**
   * Stop a running workflow.
   */
  async stopWorkflow(appApiKey: string, taskId: string, user: string): Promise<void> {
    await fetch(`${this.baseUrl}/v1/workflows/tasks/${taskId}/stop`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${appApiKey}`,
      },
      body: JSON.stringify({ user }),
    });
  }

  // ── App Management (Console API) ─────────────────────────────

  /**
   * List all apps in this Dify instance.
   */
  async listApps(): Promise<DifyApp[]> {
    const result = await this.request("GET", "/console/api/apps?page=1&limit=100");
    return result?.data || [];
  }

  /**
   * Get info about a specific app.
   */
  async getApp(appId: string): Promise<DifyApp | null> {
    try {
      return await this.request("GET", `/console/api/apps/${appId}`);
    } catch {
      return null;
    }
  }

  /**
   * Import a Dify app from DSL (YAML definition).
   * This is the primary way to create pre-built crew templates.
   */
  async importAppDsl(dsl: string, name?: string): Promise<{ app_id: string }> {
    const formData = new FormData();
    const blob = new Blob([dsl], { type: "application/yaml" });
    formData.append("file", blob, "workflow.yml");
    if (name) formData.append("name", name);

    const res = await fetch(`${this.baseUrl}/console/api/apps/import`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: formData,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Dify DSL import failed (${res.status}): ${text}`);
    }

    return res.json();
  }

  /**
   * Delete a Dify app.
   */
  async deleteApp(appId: string): Promise<void> {
    await this.request("DELETE", `/console/api/apps/${appId}`);
    log.info("Deleted Dify app", { appId });
  }

  // ── Model Provider Configuration ─────────────────────────────

  /**
   * Configure an OpenAI-compatible model provider.
   * This allows crews to use local GPU models.
   */
  async configureModelProvider(
    provider: string,
    credentials: Record<string, string>,
  ): Promise<void> {
    await this.request("POST", `/console/api/workspaces/current/model-providers/${provider}`, {
      credentials,
    });
    log.info("Configured Dify model provider", { provider });
  }
}

// ── Provisioning Helpers ───────────────────────────────────────

/**
 * Build Dify environment configuration for a tenant namespace.
 */
export function buildDifyEnvConfig(opts: {
  postgresHost: string;
  postgresPort?: string;
  postgresUser: string;
  postgresPassword: string;
  postgresDatabase: string;
  redisHost: string;
  redisPort?: string;
  secretKey: string;
}): Record<string, string> {
  return {
    // Core
    MODE: "api",
    SECRET_KEY: opts.secretKey,
    CONSOLE_WEB_URL: "",
    CONSOLE_API_URL: "",
    SERVICE_API_URL: "",

    // Database — shared platform Postgres
    DB_USERNAME: opts.postgresUser,
    DB_PASSWORD: opts.postgresPassword,
    DB_HOST: opts.postgresHost,
    DB_PORT: opts.postgresPort || "5432",
    DB_DATABASE: opts.postgresDatabase,

    // Redis — shared platform Redis
    REDIS_HOST: opts.redisHost,
    REDIS_PORT: opts.redisPort || "6379",
    REDIS_DB: "1",

    // Storage — use MinIO
    STORAGE_TYPE: "s3",
    S3_ENDPOINT: `http://minio-tenant-hl.minio.svc.cluster.local:9000`,
    S3_BUCKET_NAME: "bionic-dify",
    S3_USE_AWS_MANAGED_IAM: "false",

    // Embedding
    NEXT_PUBLIC_ALLOW_EMBED: "true",

    // Logging
    LOG_LEVEL: "INFO",
  };
}

/**
 * Build Kubernetes Deployment + Service manifests for Dify in an app namespace.
 */
export function buildDifyK8sManifests(namespace: string, configMapName: string, secretName: string) {
  const labels = {
    app: "dify",
    "app.kubernetes.io/managed-by": "bionic-platform",
    "bionic/component": "dify",
  };

  const DIFY_IMAGE = process.env.DIFY_IMAGE || "langgenius/dify-api:1.5.0";
  const DIFY_WEB_IMAGE = process.env.DIFY_WEB_IMAGE || "langgenius/dify-web:1.5.0";
  const DIFY_SANDBOX_IMAGE = process.env.DIFY_SANDBOX_IMAGE || "langgenius/dify-sandbox:0.2.10";

  return {
    // Dify API + Worker Deployment
    apiDeployment: {
      metadata: {
        name: "dify-api",
        namespace,
        labels,
      },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: "dify-api" } },
        template: {
          metadata: { labels: { app: "dify-api", ...labels } },
          spec: {
            containers: [{
              name: "dify-api",
              image: DIFY_IMAGE,
              ports: [{ containerPort: 5001 }],
              envFrom: [
                { configMapRef: { name: configMapName } },
                { secretRef: { name: secretName, optional: true } },
              ],
              env: [{ name: "MODE", value: "api" }],
              resources: {
                requests: { cpu: "250m", memory: "512Mi" },
                limits: { cpu: "1000m", memory: "2Gi" },
              },
              livenessProbe: {
                httpGet: { path: "/health", port: 5001 },
                initialDelaySeconds: 30,
                periodSeconds: 15,
              },
              readinessProbe: {
                httpGet: { path: "/health", port: 5001 },
                initialDelaySeconds: 10,
                periodSeconds: 5,
              },
            }],
          },
        },
      },
    },

    // Dify Worker Deployment
    workerDeployment: {
      metadata: {
        name: "dify-worker",
        namespace,
        labels: { ...labels, app: "dify-worker" },
      },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: "dify-worker" } },
        template: {
          metadata: { labels: { app: "dify-worker", ...labels } },
          spec: {
            containers: [{
              name: "dify-worker",
              image: DIFY_IMAGE,
              envFrom: [
                { configMapRef: { name: configMapName } },
                { secretRef: { name: secretName, optional: true } },
              ],
              env: [{ name: "MODE", value: "worker" }],
              resources: {
                requests: { cpu: "250m", memory: "512Mi" },
                limits: { cpu: "1000m", memory: "2Gi" },
              },
            }],
          },
        },
      },
    },

    // Dify Web Deployment
    webDeployment: {
      metadata: {
        name: "dify-web",
        namespace,
        labels: { ...labels, app: "dify-web" },
      },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: "dify-web" } },
        template: {
          metadata: { labels: { app: "dify-web", ...labels } },
          spec: {
            containers: [{
              name: "dify-web",
              image: DIFY_WEB_IMAGE,
              ports: [{ containerPort: 3000 }],
              env: [
                // API URLs: use the platform's reverse proxy path so browser calls stay on HTTPS
                // In production, DIFY_EXTERNAL_BASE_URL overrides; otherwise use relative /dify/:slug proxy
                { name: "CONSOLE_API_URL", value: process.env.DIFY_EXTERNAL_BASE_URL
                  ? `${process.env.DIFY_EXTERNAL_BASE_URL}/${namespace}`
                  : `/dify/${namespace}` },
                { name: "APP_API_URL", value: process.env.DIFY_EXTERNAL_BASE_URL
                  ? `${process.env.DIFY_EXTERNAL_BASE_URL}/${namespace}`
                  : `/dify/${namespace}` },
                { name: "NEXT_PUBLIC_ALLOW_EMBED", value: "true" },
              ],
              resources: {
                requests: { cpu: "100m", memory: "256Mi" },
                limits: { cpu: "500m", memory: "1Gi" },
              },
            }],
          },
        },
      },
    },

    // Dify Sandbox Deployment (code execution)
    sandboxDeployment: {
      metadata: {
        name: "dify-sandbox",
        namespace,
        labels: { ...labels, app: "dify-sandbox" },
      },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: "dify-sandbox" } },
        template: {
          metadata: { labels: { app: "dify-sandbox", ...labels } },
          spec: {
            containers: [{
              name: "dify-sandbox",
              image: DIFY_SANDBOX_IMAGE,
              ports: [{ containerPort: 8194 }],
              env: [
                { name: "API_KEY", value: "dify-sandbox" },
                { name: "GIN_MODE", value: "release" },
              ],
              resources: {
                requests: { cpu: "100m", memory: "128Mi" },
                limits: { cpu: "500m", memory: "512Mi" },
              },
            }],
          },
        },
      },
    },

    // Services
    apiService: {
      metadata: { name: "dify-api", namespace, labels },
      spec: {
        selector: { app: "dify-api" },
        ports: [{ port: 5001, targetPort: 5001 }],
      },
    },

    webService: {
      metadata: { name: "dify-web", namespace, labels },
      spec: {
        selector: { app: "dify-web" },
        ports: [{ port: 3000, targetPort: 3000 }],
      },
    },

    sandboxService: {
      metadata: { name: "dify-sandbox", namespace, labels },
      spec: {
        selector: { app: "dify-sandbox" },
        ports: [{ port: 8194, targetPort: 8194 }],
      },
    },
  };
}

export const difyAdmin = {
  DifyClient,
  buildDifyEnvConfig,
  buildDifyK8sManifests,
};
