/**
 * Classify an IP address as private / loopback / link-local / metadata-range,
 * for SSRF defense on user-supplied webhook targets. Covers IPv4 and IPv6,
 * including IPv4-mapped IPv6 (::ffff:a.b.c.d). Finding #22: the previous guard
 * only inspected IPv4 (resolve4) and used loose prefix matching, so AAAA-only
 * hosts and some IPv4 ranges slipped through.
 */

export function isPrivateIpv4(ip: string): boolean {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10) return true;                         // 10.0.0.0/8
  if (a === 127) return true;                        // loopback
  if (a === 0) return true;                          // 0.0.0.0/8
  if (a === 169 && b === 254) return true;           // link-local + cloud metadata
  if (a === 192 && b === 168) return true;           // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  return false;
}

export function isPrivateIp(ip: string): boolean {
  const addr = ip.trim().toLowerCase();
  if (!addr) return true; // treat unparseable as unsafe

  // IPv4-mapped IPv6, e.g. ::ffff:192.168.1.1
  const mapped = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateIpv4(mapped[1]);

  if (addr.includes(".") && !addr.includes(":")) return isPrivateIpv4(addr);

  // IPv6
  if (addr === "::" || addr === "::1") return true;         // unspecified / loopback
  if (addr.startsWith("fe8") || addr.startsWith("fe9") ||
      addr.startsWith("fea") || addr.startsWith("feb")) return true; // fe80::/10 link-local
  if (addr.startsWith("fc") || addr.startsWith("fd")) return true;   // fc00::/7 ULA
  return false;
}
