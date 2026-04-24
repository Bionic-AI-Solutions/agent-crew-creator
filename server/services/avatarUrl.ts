import { createHmac, timingSafeEqual } from "crypto";

const DEFAULT_SIGNED_URL_TTL_SECONDS = 30 * 24 * 60 * 60;

function getSigningSecret(): string {
  const secret = process.env.AVATAR_SIGNING_SECRET || process.env.SESSION_SECRET || "";
  if (!secret) {
    throw new Error("Avatar signing secret not configured");
  }
  return secret;
}

function signaturePayload(appSlug: string, agentName: string, expiresAt: number): string {
  return `${appSlug}:${agentName}:${expiresAt}`;
}

export function getAvatarSignedUrlTtlSeconds(): number {
  const configured = Number(process.env.AVATAR_SIGNED_URL_TTL_SECONDS || "");
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_SIGNED_URL_TTL_SECONDS;
}

export function signAvatarImageUrl(
  baseUrl: string,
  appSlug: string,
  agentName: string,
  nowMs: number = Date.now(),
): string {
  const expiresAt = Math.floor(nowMs / 1000) + getAvatarSignedUrlTtlSeconds();
  const signature = createHmac("sha256", getSigningSecret())
    .update(signaturePayload(appSlug, agentName, expiresAt))
    .digest("base64url");
  const url = new URL(
    `/api/apps/${encodeURIComponent(appSlug)}/agents/${encodeURIComponent(agentName)}/avatar-image`,
    baseUrl,
  );
  url.searchParams.set("expires", String(expiresAt));
  url.searchParams.set("signature", signature);
  return url.toString();
}

export function verifyAvatarImageSignature(
  appSlug: string,
  agentName: string,
  expiresAt: number,
  signature: string,
): boolean {
  if (!Number.isFinite(expiresAt) || expiresAt < Math.floor(Date.now() / 1000) || !signature) {
    return false;
  }

  const expected = createHmac("sha256", getSigningSecret())
    .update(signaturePayload(appSlug, agentName, expiresAt))
    .digest("base64url");
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}
