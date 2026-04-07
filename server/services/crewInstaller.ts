/**
 * Crew template installer — one-click install via Dify SSO.
 *
 * Flow:
 *   1. Load template YAML, validate user-supplied config.
 *   2. Render {{config.*}} and {{auto.*}} placeholders into the Dify DSL.
 *      - config.* come from the user (configSchema fields).
 *      - auto.* are server-resolved (Letta URLs/keys, MCP search URL/key,
 *        notify webhook URL/token, agent's Letta agentId).
 *   3. Login to Dify console as the platform admin (reuses the existing
 *      DIFY_ADMIN_EMAIL/DIFY_ADMIN_PASSWORD pattern from getDifyEmbedUrl).
 *   4. POST the rendered DSL to /console/api/apps/import → returns app_id.
 *   5. Create an API key for the new app via /console/api/apps/{id}/api-keys.
 *   6. Insert a `crews` row, write the api key into Vault, link the crew to
 *      the agent in `agent_crews`.
 *   7. If the template declares postInstall: scrape_website, kick off the
 *      site-scraper which crawls the URL via Search MCP and writes chunks as
 *      Letta archival passages on the agent's Letta agentId.
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

async function importDsl(token: string, dsl: string, name: string): Promise<string> {
  // Dify accepts either multipart import or YAML content via JSON. Use the
  // YAML-content variant which the console UI also uses for "import from text".
  const res = await fetch(`${DIFY_INTERNAL}/console/api/apps/imports`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ mode: "yaml-content", yaml_content: dsl, name }),
  });
  if (!res.ok) {
    throw new Error(`Dify DSL import failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as any;
  const appId = data?.app_id || data?.id;
  if (!appId) throw new Error("Dify import returned no app_id");
  return appId;
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
  });

  const token = await loginDify();
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
    } else {
      log.warn("scrape_website requested but missing website_url or lettaAgentId", {
        hasUrl: Boolean(websiteUrl),
        hasAgent: Boolean(ctx.lettaAgentId),
      });
    }
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
