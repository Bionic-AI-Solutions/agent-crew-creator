/**
 * Search MCP client — wraps the local Bionic Search MCP REST endpoints
 * at https://mcp.baisoln.com/search/*. Provides search + crawl helpers.
 *
 * The API key is loaded from Vault path `secret/data/platform/search-mcp`
 * (key: `api_key`), with env var `SEARCH_MCP_API_KEY` as a fallback for
 * local development. Throws if neither is configured — never fakes success.
 */
import { createLogger } from "../_core/logger.js";

const log = createLogger("SearchMCP");

const SEARCH_MCP_BASE_URL =
  process.env.SEARCH_MCP_BASE_URL || "https://mcp.baisoln.com/search";

let cachedKey: string | null = null;

async function getApiKey(): Promise<string> {
  if (cachedKey) return cachedKey;
  // Try Vault first
  try {
    const { readPlatformSecret } = await import("../vaultClient.js");
    const secrets = await readPlatformSecret("search-mcp");
    if (secrets?.api_key) {
      cachedKey = secrets.api_key;
      return cachedKey;
    }
  } catch (err) {
    log.warn("Vault read failed for search-mcp, falling back to env", { error: String(err) });
  }
  const envKey = process.env.SEARCH_MCP_API_KEY;
  if (envKey) {
    cachedKey = envKey;
    return cachedKey;
  }
  throw new Error(
    "Search MCP API key not configured. Set vault secret/data/platform/search-mcp.api_key or env SEARCH_MCP_API_KEY",
  );
}

async function request(path: string, body?: unknown): Promise<any> {
  const key = await getApiKey();
  const url = `${SEARCH_MCP_BASE_URL}${path}`;
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": key,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Search MCP ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Run a web search query. */
export async function search(query: string, limit = 10): Promise<SearchResult[]> {
  const data = await request("/search", { query, limit });
  return Array.isArray(data?.results) ? data.results : [];
}

export interface CrawlPage {
  url: string;
  title: string;
  text: string;
}

/**
 * Crawl a website (BFS from rootUrl, respecting same-origin) and return
 * extracted text per page. Used by the Customer Service template installer
 * to seed the RAG store.
 */
export async function crawl(
  rootUrl: string,
  opts: { maxPages?: number; maxDepth?: number } = {},
): Promise<CrawlPage[]> {
  const data = await request("/crawl", {
    url: rootUrl,
    max_pages: opts.maxPages ?? 50,
    max_depth: opts.maxDepth ?? 3,
  });
  return Array.isArray(data?.pages) ? data.pages : [];
}

/** Health check — for diagnostics only. */
export async function ping(): Promise<boolean> {
  try {
    await request("/health");
    return true;
  } catch {
    return false;
  }
}
