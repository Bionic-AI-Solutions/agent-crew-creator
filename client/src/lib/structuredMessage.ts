/**
 * Parsing for the structured payloads the agent publishes on lk.chat.summary
 * and lk.chat.presentation.
 *
 * This lives here because it was written twice — once in the embed widget's
 * ChatMessage and once in the Playground's SecondaryAgentMessage — and the two
 * copies drifted. A truncation fix applied to one left the other rendering
 * half-arrived JSON at the user, which is the fourth time in this codebase a
 * defect was fixed on the embed path and left standing on the Playground one.
 * One parser, two call sites.
 */

export interface StructuredArtifact {
  type: "artifact";
  subtype?: "image" | "file" | string;
  title: string;
  image_url?: string;
  download_url?: string;
  url?: string;
  content_type?: string;
  summary?: string;
}

export interface StructuredStatus {
  type: "status";
  message: string;
  step?: number;
  total?: number;
}

export interface StructuredSummary {
  type: "summary";
  content: string;
  citations?: string[];
}

export type StructuredMessage =
  | StructuredArtifact
  | StructuredStatus
  | StructuredSummary;

/**
 * `null` — ordinary text, render it.
 * `"incomplete"` — still arriving, render nothing yet.
 */
export type ParseResult = StructuredMessage | null | "incomplete";

const RENDERABLE_TYPES = ["artifact", "status", "summary"];

/**
 * True if the text ends mid-object or mid-string, i.e. more is still coming.
 *
 * A parse failure on its own is NOT grounds to hide a part. These payloads
 * arrive over a text stream that re-emits its accumulated prefix on every
 * chunk and splits at 15_000 bytes, which a few artifacts reach easily — each
 * repeats the same presigned S3 URL in three fields, and those carry long
 * signature query strings. But suppressing everything unparseable that opens
 * with a brace hides real prose permanently, since TextStreamData carries no
 * "stream complete" flag to wait for: `{ name: "Ada" } is an object literal`
 * and `{{playerName}} will now begin` both fail JSON.parse, and an agent that
 * teaches syntax will say things like that.
 *
 * Truncation is the discriminator. A half-arrived object has opened more
 * braces than it has closed, or stops inside a string; prose closes what it
 * opens. Braces inside string values are ignored, which matters because a
 * title or URL can contain one.
 */
export function looksTruncated(text: string): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
  }
  return depth > 0 || inString;
}

/** Parse one "\n\n"-delimited part of an agent message. */
export function parseStructuredPart(part: string): ParseResult {
  const trimmed = part.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed.type === "string" && RENDERABLE_TYPES.includes(parsed.type)) {
      return parsed as StructuredMessage;
    }
    // Valid JSON of a shape we do not render: show it rather than swallow it.
    return null;
  } catch {
    return looksTruncated(trimmed) ? "incomplete" : null;
  }
}

/**
 * Split an agent message into the structured payloads it carries and the plain
 * text around them. Parts still arriving are dropped from both.
 */
export function splitStructuredMessage(message: string): {
  structured: StructuredMessage[];
  plainParts: string[];
} {
  const structured: StructuredMessage[] = [];
  const plainParts: string[] = [];
  for (const part of message.split("\n\n")) {
    const parsed = parseStructuredPart(part);
    if (parsed === "incomplete") continue;
    if (parsed) structured.push(parsed);
    else if (part.trim()) plainParts.push(part);
  }
  return { structured, plainParts };
}
