/**
 * Crew template installer.
 *
 * Auth model: this server holds the Dify console admin credentials in
 * env (DIFY_ADMIN_EMAIL / DIFY_ADMIN_PASSWORD) and uses Dify's *password*
 * login to obtain a console session token. This is NOT Keycloak SSO —
 * the end user's Keycloak session is never forwarded to Dify. The
 * end-user-facing flow looks like one click because the platform performs
 * the install on their behalf using the platform's own service identity.
 * Audit implication: anything installCrewTemplate does in Dify is owned
 * by whoever DIFY_ADMIN_EMAIL points at, not by the calling user.
 *
 * Flow:
 *   1. Load template YAML, validate user-supplied config.
 *   2. Render {{config.*}} and {{auto.*}} placeholders into the Dify DSL.
 *      - config.* come from the user (configSchema fields).
 *      - auto.* are server-resolved (Letta URLs/keys, MCP search URL/key,
 *        notify webhook URL/token, agent's Letta agentId).
 *   3. If a previous install of the same template exists for this app,
 *      delete the orphan Dify app and Vault key first.
 *   4. Login to Dify console as the platform admin (password login).
 *   5. POST the rendered DSL to /console/api/apps/imports (json yaml-content
 *      mode) — falls back to multipart /console/api/apps/import if the
 *      console version doesn't accept the json variant.
 *   6. Create an API key for the new app via /console/api/apps/{id}/api-keys.
 *   7. Insert a `crews` row, write the api key into Vault, link the crew
 *      to the agent in `agent_crews`.
 *   8. If the template declares postInstall: scrape_website, kick off the
 *      site-scraper which crawls the URL via Search MCP and writes chunks
 *      as Letta archival passages on the agent's Letta agentId.
 */
import { createLogger } from "../_core/logger.js";
import {
  getTemplate,
  renderDsl,
  type CrewTemplate,
} from "./crewTemplateLoader.js";
import { readPlatformSecret, writeAppSecret, readAppSecret } from "../vaultClient.js";
import { crawl } from "./searchMcp.js";
import { getNotifyToken } from "./notifyService.js";

const log = createLogger("CrewInstaller");

const DIFY_NS = "bionic-platform";
const DIFY_INTERNAL = `http://dify-api.${DIFY_NS}.svc.cluster.local:5001`;

async function loginDify(): Promise<string> {
  const email = process.env.DIFY_ADMIN_EMAIL || "admin@bionic.local";
  const password = process.env.DIFY_ADMIN_PASSWORD || "B10n1cD1fy!2026";
  const res = await fetch(`${DIFY_INTERNAL}/console/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw new Error(`Dify admin login failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as any;
  const token = data?.data?.access_token;
  if (!token) throw new Error("Dify login returned no access_token");
  return token;
}

/**
 * Import a Dify app DSL. Tries the JSON yaml-content variant first
 * (`/console/api/apps/imports`, used by the console "import from text"
 * dialog) and falls back to the multipart `/console/api/apps/import`
 * endpoint if the first variant returns a 4xx — keeps us working across
 * Dify console versions without operators having to choose.
 */
async function importDsl(token: string, dsl: string, name: string): Promise<string> {
  // Variant 1: JSON yaml-content
  try {
    const res = await fetch(`${DIFY_INTERNAL}/console/api/apps/imports`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ mode: "yaml-content", yaml_content: dsl, name }),
    });
    if (res.ok) {
      const data = (await res.json()) as any;
      const appId = data?.app_id || data?.id;
      if (appId) return appId;
      throw new Error("Dify json import returned no app_id");
    }
    if (res.status < 400 || res.status >= 500) {
      throw new Error(`Dify json import failed (${res.status}): ${await res.text()}`);
    }
    log.warn("Dify json import returned 4xx — falling back to multipart", {
      status: res.status,
    });
  } catch (err) {
    log.warn("Dify json import threw — falling back to multipart", {
      error: String(err),
    });
  }

  // Variant 2: multipart file upload
  const formData = new FormData();
  const blob = new Blob([dsl], { type: "application/yaml" });
  formData.append("file", blob, "workflow.yml");
  if (name) formData.append("name", name);
  const res2 = await fetch(`${DIFY_INTERNAL}/console/api/apps/import`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });
  if (!res2.ok) {
    throw new Error(`Dify multipart import failed (${res2.status}): ${await res2.text()}`);
  }
  const data2 = (await res2.json()) as any;
  const appId2 = data2?.app_id || data2?.id;
  if (!appId2) throw new Error("Dify multipart import returned no app_id");
  return appId2;
}

/** Best-effort delete of a Dify app. Logs but does not throw on failure
 *  so that re-install never gets stuck on a stale orphan. */
async function deleteDifyApp(token: string, appId: string): Promise<void> {
  try {
    const res = await fetch(`${DIFY_INTERNAL}/console/api/apps/${appId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok || res.status === 404) {
      log.info("Deleted old Dify app", { appId, status: res.status });
      return;
    }
    log.warn("Dify app delete returned non-OK", {
      appId,
      status: res.status,
      body: await res.text(),
    });
  } catch (err) {
    log.warn("Dify app delete threw", { appId, error: String(err) });
  }
}

async function createApiKey(token: string, appId: string): Promise<string> {
  const res = await fetch(`${DIFY_INTERNAL}/console/api/apps/${appId}/api-keys`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    throw new Error(`Dify create-api-key failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as any;
  const key = data?.token || data?.api_key;
  if (!key) throw new Error("Dify create-api-key returned no token");
  return key;
}

async function resolveAutoConfig(opts: {
  appSlug: string;
  lettaAgentId: string | null;
}): Promise<Record<string, string>> {
  // MCP search
  let mcpKey = "";
  try {
    const platSecrets = await readPlatformSecret("search-mcp");
    mcpKey = platSecrets?.api_key || process.env.SEARCH_MCP_API_KEY || "";
  } catch {
    mcpKey = process.env.SEARCH_MCP_API_KEY || "";
  }
  const mcpUrl = process.env.SEARCH_MCP_BASE_URL || "https://mcp.baisoln.com/search";

  // Letta — actual cluster service is letta-server.letta.svc.cluster.local:8283
  const lettaBase =
    process.env.LETTA_BASE_URL ||
    "http://letta-server.letta.svc.cluster.local:8283";
  const lettaKey = process.env.LETTA_API_KEY || "";

  // Notify webhook URL — point Dify pods at our internal server
  // Service: bionic-platform.bionic-platform.svc.cluster.local:80 → 3000
  const notifyBase =
    process.env.BIONIC_INTERNAL_BASE_URL ||
    `http://bionic-platform.bionic-platform.svc.cluster.local`;
  const notifyUrl = `${notifyBase}/api/webhooks/notify`;
  const notifyToken = await getNotifyToken();

  return {
    mcp_search_url: mcpUrl,
    mcp_search_api_key: mcpKey,
    letta_base_url: lettaBase,
    letta_api_key: lettaKey,
    letta_agent_id: opts.lettaAgentId || "",
    notify_webhook_url: notifyUrl,
    notify_token: notifyToken,
  };
}

/**
 * Render both {{config.*}} and {{auto.*}} placeholders.
 * crewTemplateLoader.renderDsl handles config.*; we run a second pass for auto.*.
 */
function renderAuto(dsl: string, auto: Record<string, string>): string {
  let out = dsl;
  for (const [k, v] of Object.entries(auto)) {
    out = out.replaceAll(`{{auto.${k}}}`, String(v).replace(/"/g, '\\"'));
  }
  return out;
}

export interface InstallContext {
  templateId: string;
  agentConfigId: number;
  appId: number;
  appSlug: string;
  lettaAgentId: string | null;
  config: Record<string, string>;
  /** If a previous install of the same template exists, the caller passes
   *  its difyAppId here so we can delete the orphan before re-importing. */
  previousDifyAppId?: string | null;
}

export interface InstallResult {
  difyAppId: string;
  difyApiKey: string;
  template: CrewTemplate;
  renderedDsl: string;
  postInstallStarted: boolean;
}

/**
 * Install a template into Dify and return the resulting app id + api key.
 * Caller is responsible for inserting the `crews` row and `agent_crews` link.
 */
export async function installTemplate(ctx: InstallContext): Promise<InstallResult> {
  const template = getTemplate(ctx.templateId);
  if (!template) throw new Error(`Unknown template: ${ctx.templateId}`);

  // Hard precondition for templates whose runtime depends on Letta archival
  // (currently customer_service, document_qa). Without a Letta agent we
  // would silently produce a degraded crew that always retrieves "(no
  // passages)" — better to fail loudly at install time and let the user
  // provision a Letta agent first.
  const needsLetta =
    template.metadata.postInstall === "scrape_website" ||
    template.metadata.id === "document_qa" ||
    template.metadata.id === "customer_service";
  if (needsLetta && !ctx.lettaAgentId) {
    throw new Error(
      `Template "${template.metadata.label}" requires the agent to have a Letta agent provisioned (no lettaAgentId on agentConfig).`,
    );
  }

  // Render config first (validates required fields), then auto-config.
  const dslWithConfig = renderDsl(template, ctx.config);
  const auto = await resolveAutoConfig({
    appSlug: ctx.appSlug,
    lettaAgentId: ctx.lettaAgentId,
  });
  const renderedDsl = renderAuto(dslWithConfig, auto);

  log.info("Installing crew template", {
    templateId: ctx.templateId,
    agentConfigId: ctx.agentConfigId,
    appId: ctx.appId,
    reinstall: Boolean(ctx.previousDifyAppId),
  });

  const token = await loginDify();

  // Reinstall: best-effort delete the orphan Dify app and remove its
  // Vault key BEFORE creating the new one. We don't fail the reinstall
  // on cleanup errors (the old app may already be gone), but we log them.
  if (ctx.previousDifyAppId) {
    await deleteDifyApp(token, ctx.previousDifyAppId);
    try {
      const existing = (await readAppSecret(ctx.appSlug)) || {};
      delete existing[`dify_crew_${template.metadata.id}_api_key`];
      await writeAppSecret(ctx.appSlug, existing);
    } catch (err) {
      log.warn("Vault key cleanup on reinstall failed", { error: String(err) });
    }
  }

  const difyAppId = await importDsl(token, renderedDsl, template.metadata.label);
  const difyApiKey = await createApiKey(token, difyAppId);

  // Persist API key in Vault under the app slug.
  try {
    const existing = (await readAppSecret(ctx.appSlug)) || {};
    existing[`dify_crew_${template.metadata.id}_api_key`] = difyApiKey;
    await writeAppSecret(ctx.appSlug, existing);
  } catch (err) {
    log.warn("Vault write failed (continuing — key returned to caller)", {
      error: String(err),
    });
  }

  // Optional post-install side effect (fire-and-forget).
  let postInstallStarted = false;
  if (template.metadata.postInstall === "scrape_website") {
    const websiteUrl = ctx.config.website_url;
    const maxPages = parseInt(ctx.config.max_pages || "50", 10);
    if (websiteUrl && ctx.lettaAgentId) {
      postInstallStarted = true;
      // Don't await — scraping can take minutes. Errors logged.
      scrapeIntoLetta(websiteUrl, ctx.lettaAgentId, maxPages).catch((err) =>
        log.error("Background scrape failed", {
          websiteUrl,
          error: String(err),
        }),
      );
    }
    // No else branch — needsLetta check above already prevented the
    // missing-lettaAgentId case from getting here.
  }

  return { difyAppId, difyApiKey, template, renderedDsl, postInstallStarted };
}

/**
 * Crawl a website via Search MCP and store extracted text as Letta archival
 * passages on the given agent. Chunks pages by ~2000-char windows so they fit
 * comfortably inside Letta's per-passage limit and retrieve well.
 */
async function scrapeIntoLetta(
  websiteUrl: string,
  lettaAgentId: string,
  maxPages: number,
): Promise<void> {
  log.info("Starting website scrape", { websiteUrl, lettaAgentId, maxPages });
  const pages = await crawl(websiteUrl, { maxPages });
  log.info("Scrape returned pages", { count: pages.length });
  const { createPassage } = await import("./lettaAdmin.js");
  let stored = 0;
  for (const page of pages) {
    const text = page.text || "";
    if (!text.trim()) continue;
    // Chunk to ~2000 chars
    for (let i = 0; i < text.length; i += 2000) {
      const chunk = text.slice(i, i + 2000);
      const header = `Source: ${page.title || page.url}\nURL: ${page.url}\n\n`;
      try {
        await createPassage(lettaAgentId, header + chunk);
        stored++;
      } catch (err) {
        log.warn("Failed to store passage", { url: page.url, error: String(err) });
      }
    }
  }
  log.info("Scrape complete", { websiteUrl, pagesStored: stored });
}
