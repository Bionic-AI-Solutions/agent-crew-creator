-- Vision tuning moves into the DB.
--
-- VISION_MAX_IMAGES and VISION_PROACTIVE existed only as hand-patched
-- ConfigMap keys. agentDeployer rebuilds the ConfigMap from these rows on
-- every save, so editing an agent in the builder silently wiped them: jarvis
-- lost both the moment its LLM model was changed, and went back to holding 4
-- frames per turn with proactive vision off.
--
-- Default 1, not the code's 4: only the newest frame is normally what the
-- user is asking about, and each retained frame is re-prefilled uncached on
-- every subsequent turn.
ALTER TABLE "agent_configs" ADD COLUMN IF NOT EXISTS "vision_max_images" integer DEFAULT 1 NOT NULL;
ALTER TABLE "agent_configs" ADD COLUMN IF NOT EXISTS "vision_proactive" boolean DEFAULT false NOT NULL;
