/**
 * GET /api/agents
 *
 * Lists deployed agents for this app. Calls the platform API using
 * the internal service URL. The platform identifies the app by slug
 * (from APP_SLUG env var).
 *
 * Returns: { agents: Array<{ id, name, displayName, deployed }> }
 */
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

interface AgentInfo {
  id: number;
  name: string;
  displayName: string;
  deployed: boolean;
  dispatchName: string;
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const platformUrl = process.env.PLATFORM_API_URL;
  const appSlug = process.env.APP_SLUG;

  if (!platformUrl || !appSlug) {
    return Response.json({ agents: [] });
  }

  try {
    // Call platform internal API for agent list
    const url = `${platformUrl}/api/player-ui/agents?slug=${encodeURIComponent(appSlug)}`;
    const res = await fetch(url, {
      headers: { "X-Internal-Token": process.env.PLAYER_UI_INTERNAL_TOKEN || process.env.PLATFORM_INTERNAL_TOKEN || "" },
      next: { revalidate: 30 }, // cache for 30s
    });

    if (!res.ok) {
      console.error("Platform API error:", res.status, await res.text());
      return Response.json({ agents: [] });
    }

    const data = (await res.json()) as { agents: AgentInfo[] };
    return Response.json(data);
  } catch (err) {
    console.error("Failed to fetch agents:", err);
    return Response.json({ agents: [] });
  }
}
