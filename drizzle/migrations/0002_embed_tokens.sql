-- Embed Tokens: per-agent embeddable widget keys for external sites.
-- Each token grants anonymous LiveKit access to a specific deployed agent.

CREATE TABLE IF NOT EXISTS "embed_tokens" (
  "id" serial PRIMARY KEY NOT NULL,
  "agent_config_id" integer NOT NULL REFERENCES "agent_configs"("id") ON DELETE CASCADE,
  "app_id" integer NOT NULL REFERENCES "apps"("id") ON DELETE CASCADE,
  "token" varchar(64) NOT NULL UNIQUE,
  "label" varchar(100) DEFAULT 'default' NOT NULL,
  "allow_voice" boolean DEFAULT true NOT NULL,
  "allow_chat" boolean DEFAULT true NOT NULL,
  "allow_video" boolean DEFAULT false NOT NULL,
  "allow_screen_share" boolean DEFAULT false NOT NULL,
  "allow_avatar" boolean DEFAULT false NOT NULL,
  "show_transcription" boolean DEFAULT true NOT NULL,
  "theme" varchar(20) DEFAULT 'light' NOT NULL,
  "mode" varchar(20) DEFAULT 'popup' NOT NULL,
  "allowed_origins" json DEFAULT '[]',
  "is_active" boolean DEFAULT true NOT NULL,
  "last_used_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_embed_tokens_agent"
  ON "embed_tokens" ("agent_config_id");
CREATE INDEX IF NOT EXISTS "idx_embed_tokens_token"
  ON "embed_tokens" ("token");
