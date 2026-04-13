/**
 * POST /api/livekit/token
 *
 * Mints a LiveKit join token for an authenticated user + selected agent.
 * LiveKit creds come from K8s secret (env vars). Agent dispatch is set
 * via RoomConfiguration so the right worker auto-joins.
 *
 * Body: { agentName: string }
 * Returns: { token, livekitUrl, roomName, identity }
 */
import { getServerSession } from "next-auth";
import { AccessToken } from "livekit-server-sdk";
import { authOptions } from "@/lib/auth";
import { randomUUID } from "crypto";

const TTL = 3600; // 1 hour

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { agentName } = (await req.json()) as { agentName?: string };
  if (!agentName) {
    return Response.json({ error: "agentName required" }, { status: 400 });
  }

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const livekitUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL || process.env.LIVEKIT_URL;

  if (!apiKey || !apiSecret || !livekitUrl) {
    return Response.json({ error: "LiveKit not configured" }, { status: 500 });
  }

  try {
    const userSub = (session as any).user?.sub || session.user.email || "anon";
    const identity = userSub;
    const displayName = session.user.name || session.user.email || identity;
    const slug = process.env.APP_SLUG || "app";
    const shortId = randomUUID().slice(0, 8);
    const roomName = `app-${slug}-${agentName.replace(`${slug}-`, "")}-${identity.slice(0, 8)}-${shortId}`;

    const at = new AccessToken(apiKey, apiSecret, {
      identity,
      name: displayName,
      ttl: TTL,
    });
    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      roomCreate: true,
    });

    // Dispatch the named agent worker into this room.
    // Set roomConfig with minimal fields to avoid protobuf version mismatch.
    at.roomConfig = {
      agents: [{ agentName }],
    } as any;

    const token = await at.toJwt();

    return Response.json({
      token,
      livekitUrl,
      roomName,
      identity,
      displayName,
    });
  } catch (err: any) {
    console.error("Token generation error:", err);
    return Response.json({ error: err.message || "Token generation failed" }, { status: 500 });
  }
}
