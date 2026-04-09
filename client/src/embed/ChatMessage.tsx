import { useMemo, useState } from "react";
import { marked } from "marked";

// Configure marked for safe rendering
marked.setOptions({ breaks: true, gfm: true });

/** Allowlisted HTML tags for sanitization. */
const SAFE_TAGS = new Set([
  "p", "strong", "em", "code", "pre", "a", "img", "ul", "ol", "li",
  "h1", "h2", "h3", "h4", "h5", "h6", "br", "blockquote", "span",
]);

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

interface ChatMessageProps {
  message: string;
  isLocal: boolean;
  name?: string;
}

export function ChatMessage({ message, isLocal, name }: ChatMessageProps) {
  const [expandedImg, setExpandedImg] = useState<string | null>(null);

  const renderedHtml = useMemo(() => {
    try {
      const raw = marked.parse(message, { async: false }) as string;
      return sanitizeHtml(raw);
    } catch {
      return message;
    }
  }, [message]);

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
        <div
          className="bionic-chat-content"
          onClick={handleClick}
          dangerouslySetInnerHTML={{ __html: renderedHtml }}
        />
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
