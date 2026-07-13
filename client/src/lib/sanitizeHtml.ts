/**
 * Central rich-text sanitizer for agent/tool output rendered via
 * dangerouslySetInnerHTML. Agent, Letta, RAG and MCP-tool output is NOT fully
 * trusted (it can echo scraped web content or attacker-influenced tool
 * responses), so every markdown → HTML render must pass through DOMPurify
 * before it reaches the DOM. Replaces the previous unsanitized playground path
 * and the bypassable regex sanitizer in the embed widget.
 */
import createDOMPurify from "dompurify";
import { marked } from "marked";
import { rewriteS3UrlsInHtml } from "./s3ProxyUrl";

const ALLOWED_TAGS = [
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "a", "ul", "ol", "li",
  "blockquote", "code", "pre", "strong", "em", "b", "i", "u", "del",
  "br", "hr", "table", "thead", "tbody", "tr", "th", "td", "span", "img",
];
const ALLOWED_ATTR = ["href", "title", "src", "alt", "target", "rel", "loading"];
// Only http(s), mailto and in-page anchors — blocks javascript:/data: URLs.
const ALLOWED_URI_REGEXP = /^(?:https?:|mailto:|#)/i;

type Purifier = ReturnType<typeof createDOMPurify>;

function buildPurifier(win: Window | unknown): Purifier {
  const p = createDOMPurify(win as Window);
  // Trusted, fixed decoration applied after attribute sanitization: open links
  // in a new tab safely and lazy-load images.
  p.addHook("afterSanitizeAttributes", (node: Element) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
    if (node.tagName === "IMG") {
      node.setAttribute("loading", "lazy");
    }
  });
  return p;
}

let _purifier: Purifier | null = null;
function purifier(): Purifier {
  if (!_purifier) _purifier = buildPurifier(window);
  return _purifier;
}

/** Test-only: inject a jsdom-backed window so the sanitizer runs under Node. */
export function __setPurifierWindowForTest(win: unknown): void {
  _purifier = buildPurifier(win);
}

/**
 * Render caller-supplied markdown to sanitized HTML, then rewrite S3 URLs to
 * the platform proxy. Safe to feed into dangerouslySetInnerHTML.
 */
export function sanitizeRichText(markdown: string, platformOrigin?: string): string {
  try {
    const raw = marked.parse(markdown, { breaks: true, gfm: true, async: false }) as string;
    const clean = purifier().sanitize(raw, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      ALLOWED_URI_REGEXP,
      FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form"],
      FORBID_ATTR: ["style"],
    });
    return rewriteS3UrlsInHtml(clean, platformOrigin);
  } catch {
    // Never fall back to unsanitized content — drop to plain escaped text.
    return escapeTextToHtml(markdown);
  }
}

function escapeTextToHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
