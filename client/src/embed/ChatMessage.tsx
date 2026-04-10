import { useMemo, useState } from "react";
import { marked } from "marked";

// Configure marked for safe rendering
marked.setOptions({ breaks: true, gfm: true });

/** Strip unsafe HTML while keeping allowed tags and attributes. */
function sanitizeHtml(html: string): string {
  // Remove <script> tags and their content
  let clean = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  // Remove on* event attributes
  clean = clean.replace(/\s+on\w+\s*=\s*"[^"]*"/gi, "");
  clean = clean.replace(/\s+on\w+\s*=\s*'[^']*'/gi, "");
  // Remove javascript: URLs
  clean = clean.replace(/href\s*=\s*"javascript:[^"]*"/gi, 'href="#"');
  clean = clean.replace(/src\s*=\s*"javascript:[^"]*"/gi, 'src=""');
  // Add target="_blank" rel="noopener noreferrer" to links
  clean = clean.replace(/<a\s/gi, '<a target="_blank" rel="noopener noreferrer" ');
  // Add lazy loading and max-width to images
  clean = clean.replace(/<img\s/gi, '<img loading="lazy" style="max-width:200px;cursor:pointer;border-radius:8px;" ');
  return clean;
}

// ── Structured message types ────────────────────────────────────

interface StructuredArtifact {
  type: "artifact";
  title: string;
  download_url?: string;
  content_type?: string;
  summary?: string;
}

interface StructuredStatus {
  type: "status";
  message: string;
  step?: number;
  total?: number;
}

interface StructuredSummary {
  type: "summary";
  content: string;
  citations?: string[];
}

type StructuredMessage = StructuredArtifact | StructuredStatus | StructuredSummary;

/** Try to parse a message as a structured JSON payload. Returns null for plain text. */
function tryParseStructured(message: string): StructuredMessage | null {
  const trimmed = message.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed.type === "string" && ["artifact", "status", "summary"].includes(parsed.type)) {
      return parsed as StructuredMessage;
    }
  } catch {
    // Not JSON — treat as regular text
  }
  return null;
}

/** Sanitize a URL — only allow http/https schemes. */
function safeUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim().toLowerCase();
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) return undefined;
  return url;
}

/** Render an artifact card with optional download link and image preview. */
function ArtifactCard({ data }: { data: StructuredArtifact }) {
  const isImage = data.content_type?.startsWith("image/");
  const url = safeUrl(data.download_url);
  return (
    <div className="bionic-artifact-card">
      <div className="bionic-artifact-header">
        <span className="bionic-artifact-icon">📎</span>
        <strong>{data.title}</strong>
      </div>
      {data.summary && <p className="bionic-artifact-summary">{data.summary}</p>}
      {isImage && url && (
        <img
          src={url}
          alt={data.title}
          loading="lazy"
          className="bionic-artifact-preview"
        />
      )}
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="bionic-artifact-download"
        >
          Download
        </a>
      )}
    </div>
  );
}

/** Render a progress/status indicator inline in chat. */
function StatusIndicator({ data }: { data: StructuredStatus }) {
  const progress = data.step && data.total
    ? ` (${data.step}/${data.total})`
    : "";
  return (
    <div className="bionic-status-indicator">
      <span className="bionic-status-spinner" />
      <span>{data.message}{progress}</span>
    </div>
  );
}

/** Render a summary card with optional citations. */
function SummaryCard({ data }: { data: StructuredSummary }) {
  const renderedHtml = useMemo(() => {
    try {
      const raw = marked.parse(data.content, { async: false }) as string;
      return sanitizeHtml(raw);
    } catch {
      return data.content;
    }
  }, [data.content]);

  return (
    <div className="bionic-summary-card">
      <div
        className="bionic-chat-content"
        dangerouslySetInnerHTML={{ __html: renderedHtml }}
      />
      {data.citations && data.citations.length > 0 && (
        <div className="bionic-citations">
          <small>Sources:</small>
          <ul>
            {data.citations.map((c, i) => (
              <li key={i}><small>{c}</small></li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── Main ChatMessage component ──────────────────────────────────

interface ChatMessageProps {
  message: string;
  isLocal: boolean;
  name?: string;
}

export function ChatMessage({ message, isLocal, name }: ChatMessageProps) {
  const [expandedImg, setExpandedImg] = useState<string | null>(null);

  // Check if the message (or any line in it) is a structured JSON payload
  const { structured, plainParts } = useMemo(() => {
    const lines = message.split("\n\n");
    const structured: StructuredMessage[] = [];
    const plainParts: string[] = [];

    for (const line of lines) {
      const parsed = tryParseStructured(line);
      if (parsed) {
        structured.push(parsed);
      } else if (line.trim()) {
        plainParts.push(line);
      }
    }
    return { structured, plainParts };
  }, [message]);

  const renderedHtml = useMemo(() => {
    if (!plainParts.length) return "";
    try {
      const raw = marked.parse(plainParts.join("\n\n"), { async: false }) as string;
      return sanitizeHtml(raw);
    } catch {
      return plainParts.join("\n\n");
    }
  }, [plainParts]);

  const handleClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === "IMG") {
      const src = target.getAttribute("src");
      if (src) {
        e.preventDefault();
        setExpandedImg(src);
      }
    }
  };

  return (
    <>
      <div className={`bionic-chat-message ${isLocal ? "bionic-chat-local" : "bionic-chat-remote"}`}>
        {name && <div className="bionic-chat-name">{name}</div>}

        {/* Render plain text / markdown content */}
        {renderedHtml && (
          <div
            className="bionic-chat-content"
            onClick={handleClick}
            dangerouslySetInnerHTML={{ __html: renderedHtml }}
          />
        )}

        {/* Render structured messages as rich cards */}
        {structured.map((item, idx) => {
          switch (item.type) {
            case "artifact":
              return <ArtifactCard key={`struct-${idx}`} data={item} />;
            case "status":
              return <StatusIndicator key={`struct-${idx}`} data={item} />;
            case "summary":
              return <SummaryCard key={`struct-${idx}`} data={item} />;
            default:
              return null;
          }
        })}
      </div>

      {/* Lightbox for expanded images */}
      {expandedImg && (
        <div className="bionic-lightbox" onClick={() => setExpandedImg(null)}>
          <img src={expandedImg} alt="Expanded" className="bionic-lightbox-img" />
        </div>
      )}
    </>
  );
}
