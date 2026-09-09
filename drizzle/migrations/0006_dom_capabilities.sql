-- Browser awareness and control, per agent and per embed token.
--
-- Two layers, mirroring how vision already works: agent_configs says what the
-- worker is capable of (it decides whether the tools are registered and how
-- the persona reads), embed_tokens says what a given deployment is permitted
-- to expose. Without the second layer every token issued for an agent would
-- inherit the right to drive the host page, including tokens handed to third
-- party sites.
--
-- Read and control are separate columns rather than one level, because they
-- have genuinely different blast radii: reading is passive and reversible,
-- acting is neither. The builder switches read on alongside screen share, so
-- the common case is still one choice.
ALTER TABLE "agent_configs" ADD COLUMN IF NOT EXISTS "dom_read_enabled" boolean DEFAULT false NOT NULL;
ALTER TABLE "agent_configs" ADD COLUMN IF NOT EXISTS "dom_control_enabled" boolean DEFAULT false NOT NULL;

ALTER TABLE "embed_tokens" ADD COLUMN IF NOT EXISTS "allow_dom_read" boolean DEFAULT false NOT NULL;
ALTER TABLE "embed_tokens" ADD COLUMN IF NOT EXISTS "allow_dom_control" boolean DEFAULT false NOT NULL;
