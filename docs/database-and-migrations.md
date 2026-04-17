# Database and migrations

## Connection

- `server/db.ts` uses `DATABASE_URL` with `pg.Pool` (max 20 connections) and Drizzle ORM.
- If `DATABASE_URL` is unset, `getDb()` returns `null` and many features fail at runtime. Production must set this variable.

## Schema files

| File | Role |
|------|------|
| `drizzle/platformSchema.ts` | Primary platform tables |
| `drizzle/relations.ts` | Drizzle relations |
| `drizzle/schema.ts` | Re-exports the above (imported as `schema` in `db.ts`) |

## Primary tables (summary)

| Table | Purpose |
|-------|---------|
| `apps` | Tenant: slug, LiveKit URL, enabled services JSON, provisioning status, legacy API key fields |
| `app_members` | `(app_id, user_id)` membership; `user_id` = Keycloak `sub`; role `owner` or `member` |
| `provisioning_jobs` | Job type, status, step JSON for provision and delete pipelines |
| `agent_configs` | Agent definition, providers, Letta IDs, deployment flags, `config_version` |
| `agent_tools`, `agent_mcp_servers`, `custom_tools` | Tooling configuration |
| `crews`, `agent_crews`, `crew_executions` | Dify crew registry and execution history |
| `embed_tokens` | Public embed tokens, capability flags, `allowed_origins` |
| `agent_documents` | RAG uploads: MinIO key, chunks, Letta passage IDs, processing status |
| `user_memory_blocks` | Per-user Letta memory block linkage per agent |

## Indexes and constraints

- `app_members` has a unique index on `(app_id, user_id)` (`drizzle/platformSchema.ts`).

## Migrations (Drizzle Kit)

From `package.json`:

- `npm run db:generate` — generate migrations
- `npm run db:migrate` — apply migrations
- `npm run db:push` — push schema (dev)
- `npm run db:studio` — Drizzle Studio
