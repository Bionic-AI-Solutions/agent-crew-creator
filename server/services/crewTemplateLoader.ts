/**
 * Loads installable crew templates from server/crewTemplates/*.yaml at startup.
 *
 * Each template file has the structure:
 *   metadata:
 *     id: string                # unique slug, also used as crew name
 *     label: string
 *     description: string
 *     mode: workflow | agent-chat | completion
 *     icon: string (emoji)
 *     configSchema:             # optional fields the user must supply at install
 *       - key: website_url
 *         label: Website URL
 *         type: url | text | email
 *         required: true
 *         placeholder: https://example.com
 *     postInstall: scrape_website | none   # optional server-side action
 *   difyDsl: |
 *     <Dify app DSL — YAML string, may contain {{config.<key>}} placeholders>
 */
import { readdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";
import { createLogger } from "../_core/logger.js";

const log = createLogger("CrewTemplateLoader");

export interface ConfigField {
  key: string;
  label: string;
  type: "text" | "url" | "email" | "textarea";
  required: boolean;
  placeholder?: string;
  description?: string;
}

export interface CrewTemplateMetadata {
  id: string;
  label: string;
  description: string;
  mode: "workflow" | "agent-chat" | "completion";
  icon?: string;
  configSchema?: ConfigField[];
  postInstall?: "scrape_website" | "none";
}

export interface CrewTemplate {
  metadata: CrewTemplateMetadata;
  difyDsl: string;
}

let cache: CrewTemplate[] | null = null;

function templatesDir(): string {
  // When compiled, __dirname is dist/server/services. Source files live in
  // server/crewTemplates relative to repo root. Resolve via import.meta.url.
  const here = dirname(fileURLToPath(import.meta.url));
  // Try both source and dist layouts
  const candidates = [
    join(here, "..", "crewTemplates"),
    join(here, "..", "..", "..", "server", "crewTemplates"),
    join(process.cwd(), "server", "crewTemplates"),
  ];
  for (const c of candidates) {
    try {
      readdirSync(c);
      return c;
    } catch {
      /* try next */
    }
  }
  throw new Error("Could not locate server/crewTemplates directory");
}

function load(): CrewTemplate[] {
  if (cache) return cache;
  const dir = templatesDir();
  const files = readdirSync(dir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  const out: CrewTemplate[] = [];
  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), "utf-8");
      const parsed = yaml.load(raw) as any;
      if (!parsed?.metadata?.id || typeof parsed?.difyDsl !== "string") {
        log.warn("Skipping malformed template", { file });
        continue;
      }
      out.push({ metadata: parsed.metadata, difyDsl: parsed.difyDsl });
    } catch (err) {
      log.error("Failed to load template", { file, error: String(err) });
    }
  }
  out.sort((a, b) => a.metadata.label.localeCompare(b.metadata.label));
  cache = out;
  log.info("Loaded crew templates", { count: out.length });
  return out;
}

export function listTemplates(): CrewTemplateMetadata[] {
  return load().map((t) => t.metadata);
}

export function getTemplate(id: string): CrewTemplate | null {
  return load().find((t) => t.metadata.id === id) || null;
}

/**
 * Render {{config.<key>}} placeholders in the DSL with provided values.
 * Missing required fields throw.
 */
export function renderDsl(template: CrewTemplate, config: Record<string, string>): string {
  const schema = template.metadata.configSchema || [];
  for (const field of schema) {
    if (field.required && !config[field.key]) {
      throw new Error(`Missing required config field: ${field.key}`);
    }
  }
  let dsl = template.difyDsl;
  for (const [key, value] of Object.entries(config)) {
    const escaped = String(value).replace(/"/g, '\\"');
    dsl = dsl.replaceAll(`{{config.${key}}}`, escaped);
  }
  return dsl;
}
