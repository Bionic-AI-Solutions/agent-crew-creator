-- App Members: per-app RBAC join table.
-- userId is the Keycloak `sub` claim (matches SessionUser.sub).
-- Hand-written because the migrations/ dir is empty in this repo (db:push was the
-- prior workflow); a `drizzle-kit generate` baseline would try to (re)create all
-- pre-existing tables and break a live database.

CREATE TABLE IF NOT EXISTS "app_members" (
  "id" serial PRIMARY KEY NOT NULL,
  "app_id" integer NOT NULL REFERENCES "apps"("id") ON DELETE CASCADE,
  "user_id" varchar(255) NOT NULL,
  "role" varchar(20) DEFAULT 'member' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_app_members_unique"
  ON "app_members" ("app_id", "user_id");
CREATE INDEX IF NOT EXISTS "idx_app_members_user"
  ON "app_members" ("user_id");
