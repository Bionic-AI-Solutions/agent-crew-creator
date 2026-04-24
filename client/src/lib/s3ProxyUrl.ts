/**
 * Rewrite MinIO public URLs to the platform /api/s3-proxy path so pages and
 * embedded widgets on arbitrary origins load assets from the platform (avoids
 * Chrome Private Network Access blocks when s3 hostnames resolve privately).
 */

const S3_PUBLIC_HOSTS = new Set([
  "s3.baisoln.com",
  "s3.bionicaisolutions.com",
]);

export function isS3PublicHost(hostname: string): boolean {
  return S3_PUBLIC_HOSTS.has(hostname.toLowerCase());
}

/**
 * @param platformOrigin e.g. https://platform.baisoln.com — required when the UI runs on another origin (embed popup). Omit for same-origin platform pages (relative /api/s3-proxy).
 */
export function toBrowserS3ProxyUrl(href: string, platformOrigin?: string): string {
  const trimmed = href.trim();
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "https:" && u.protocol !== "http:") return trimmed;
    if (!isS3PublicHost(u.hostname)) return trimmed;
    const path = `/api/s3-proxy${u.pathname}${u.search}`;
    const base = platformOrigin?.replace(/\/$/, "") ?? "";
    return base ? `${base}${path}` : path;
  } catch {
    return trimmed;
  }
}

/** Rewrite img src= and a href= pointing at our S3 hosts inside HTML fragments. */
export function rewriteS3UrlsInHtml(html: string, platformOrigin?: string): string {
  const base = platformOrigin?.replace(/\/$/, "") ?? "";
  return html.replace(
    /\b(src|href)=(["'])(https?:\/\/[^"']+)\2/gi,
    (full, attr: string, quote: string, url: string) => {
      try {
        const u = new URL(url);
        if (!isS3PublicHost(u.hostname)) return full;
        const path = `/api/s3-proxy${u.pathname}${u.search}`;
        const next = base ? `${base}${path}` : path;
        return `${attr}=${quote}${next}${quote}`;
      } catch {
        return full;
      }
    },
  );
}
