-- Additive migration: avatar_provider + reference_image + avatar_name on
-- agent_configs; deleted_at + status index on agent_documents; bumped
-- default LLM for the Letta secondary brain to Qwen 3.6 thinking.
--
-- Existing rows are unaffected — new columns are nullable or have
-- defaults, and the letta_llm_model default change only applies to
-- future inserts (any row inserted before this migration keeps its
-- prior value).

ALTER TABLE "agent_configs"
    ADD COLUMN IF NOT EXISTS "avatar_provider" varchar(30) DEFAULT 'flashhead',
    ADD COLUMN IF NOT EXISTS "avatar_reference_image" text,
    ADD COLUMN IF NOT EXISTS "avatar_name" varchar(100);
--> statement-breakpoint

ALTER TABLE "agent_configs"
    ALTER COLUMN "letta_llm_model" SET DEFAULT 'openai-proxy/qwen3.6-35b-a3b-fp8-think';
--> statement-breakpoint

ALTER TABLE "agent_documents"
    ADD COLUMN IF NOT EXISTS "deleted_at" timestamp;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_agent_docs_status" ON "agent_documents" ("processing_status");
