/**
 * Internal API for per-app player-ui frontends.
 * Called by the player-ui pods to list deployed agents for their app.
 *
 * Security: validated by X-Internal-Token header (shared secret in Vault).
 * This endpoint is only reachable from within the cluster.
 */
import type { Express, Request, Response, NextFunction } from "express";
import { eq, and } from "drizzle-orm";
import { getDb } from "./db.js";
import { apps, agentConfigs, userMemoryBlocks } from "../drizzle/platformSchema.js";
import { createLogger } from "./_core/logger.js";

const log = createLogger("PlayerUiApi");

export function registerPlayerUiRoutes(app: Express): void {
  app.get("/api/player-ui/agents", async (req, res) => {
    // Validate internal token — only player-ui pods should call this
    const internalToken = process.env.PLAYER_UI_INTERNAL_TOKEN;
    if (internalToken) {
      const got = req.header("X-Internal-Token");
      if (got !== internalToken) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
    } else if (process.env.NODE_ENV === "production") {
      log.error("PLAYER_UI_INTERNAL_TOKEN not set in production — rejecting request");
      res.status(503).json({ error: "internal auth not configured" });
      return;
    }

    const slug = req.query.slug as string;
    if (!slug) {
      res.status(400).json({ error: "slug required" });
      return;
    }

    const db = await getDb();
    if (!db) {
      res.status(500).json({ error: "DB unavailable" });
      return;
    }

    try {
      const [appRow] = await db.select().from(apps).where(eq(apps.slug, slug)).limit(1);
      if (!appRow) {
        res.status(404).json({ error: "App not found" });
        return;
      }

      const agents = await db
        .select({
          id: agentConfigs.id,
          name: agentConfigs.name,
          deployed: agentConfigs.deployed,
          visionEnabled: agentConfigs.visionEnabled,
          avatarEnabled: agentConfigs.avatarEnabled,
          backgroundAudioEnabled: agentConfigs.backgroundAudioEnabled,
        })
        .from(agentConfigs)
        .where(and(eq(agentConfigs.appId, appRow.id), eq(agentConfigs.deployed, true)));

      res.json({
        agents: agents.map((a) => ({
          id: a.id,
          name: a.name,
          displayName: a.name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
          deployed: a.deployed,
          dispatchName: `${slug}-${a.name}`,
          capabilities: {
            vision: a.visionEnabled,
            avatar: a.avatarEnabled,
            backgroundAudio: a.backgroundAudioEnabled,
          },
        })),
      });
    } catch (err) {
      log.error("Failed to list agents", { slug, error: String(err) });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // ── Internal auth middleware for agent-pod endpoints ─────────
  // Accepts either PLAYER_UI_INTERNAL_TOKEN or AGENT_INTERNAL_TOKEN
  // so both player-ui pods and Letta tool sandbox calls can authenticate.
  const internalAuth = (req: Request, res: Response, next: NextFunction) => {
    const playerToken = process.env.PLAYER_UI_INTERNAL_TOKEN;
    const agentToken = process.env.AGENT_INTERNAL_TOKEN;
    const got = req.header("X-Internal-Token") || "";
    if (playerToken || agentToken) {
      if (got !== playerToken && got !== agentToken) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
    } else if (process.env.NODE_ENV === "production") {
      res.status(503).json({ error: "internal auth not configured" });
      return;
    }
    next();
  };

  // ── GET /api/internal/user-memory/:agentConfigId/:userId ────
  app.get("/api/internal/user-memory/:agentConfigId/:userId", internalAuth, async (req, res) => {
    const db = await getDb();
    if (!db) { res.status(500).json({ error: "DB unavailable" }); return; }
    try {
      const agentConfigId = parseInt(req.params.agentConfigId, 10);
      const userId = req.params.userId;
      const [row] = await db
        .select()
        .from(userMemoryBlocks)
        .where(and(eq(userMemoryBlocks.agentConfigId, agentConfigId), eq(userMemoryBlocks.userId, userId)))
        .limit(1);
      if (row) {
        res.json({ lettaBlockId: row.lettaBlockId, blockLabel: row.blockLabel });
      } else {
        res.status(404).json({ error: "not found" });
      }
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── PUT /api/internal/user-memory/:agentConfigId/:userId ────
  app.put("/api/internal/user-memory/:agentConfigId/:userId", internalAuth, async (req, res) => {
    const db = await getDb();
    if (!db) { res.status(500).json({ error: "DB unavailable" }); return; }
    try {
      const agentConfigId = parseInt(req.params.agentConfigId, 10);
      const userId = req.params.userId;
      const { lettaBlockId, blockLabel } = req.body as { lettaBlockId: string; blockLabel?: string };
      if (!lettaBlockId) { res.status(400).json({ error: "lettaBlockId required" }); return; }

      // Get appId from agentConfig
      const [agent] = await db.select({ appId: agentConfigs.appId }).from(agentConfigs).where(eq(agentConfigs.id, agentConfigId)).limit(1);
      if (!agent) { res.status(404).json({ error: "agent not found" }); return; }

      // Upsert
      const existing = await db
        .select()
        .from(userMemoryBlocks)
        .where(and(eq(userMemoryBlocks.agentConfigId, agentConfigId), eq(userMemoryBlocks.userId, userId)))
        .limit(1);

      if (existing.length > 0) {
        await db.update(userMemoryBlocks)
          .set({ lettaBlockId, lastSessionAt: new Date() })
          .where(eq(userMemoryBlocks.id, existing[0].id));
      } else {
        await db.insert(userMemoryBlocks).values({
          appId: agent.appId,
          agentConfigId,
          userId,
          blockLabel: blockLabel || "human",
          lettaBlockId,
        });
      }
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── POST /api/internal/agent/:agentConfigId/avatar ─────────
  // Called by the generate_persona_image Letta tool to update the
  // agent's avatar image after generating a new persona portrait.
  app.post("/api/internal/agent/:agentConfigId/avatar", internalAuth, async (req, res) => {
    const db = await getDb();
    if (!db) { res.status(500).json({ error: "DB unavailable" }); return; }
    try {
      const agentConfigId = parseInt(req.params.agentConfigId, 10);
      const { minioPath } = req.body as { minioPath: string };
      if (!minioPath) { res.status(400).json({ error: "minioPath required" }); return; }

      const [agent] = await db
        .select({ id: agentConfigs.id })
        .from(agentConfigs)
        .where(eq(agentConfigs.id, agentConfigId))
        .limit(1);
      if (!agent) { res.status(404).json({ error: "agent not found" }); return; }

      await db
        .update(agentConfigs)
        .set({ avatarImageUrl: minioPath, updatedAt: new Date() })
        .where(eq(agentConfigs.id, agentConfigId));

      log.info("Avatar updated via internal API", { agentConfigId, minioPath });
      res.json({ success: true });
    } catch (err) {
      log.error("Failed to update avatar", { error: String(err) });
      res.status(500).json({ error: String(err) });
    }
  });
}
