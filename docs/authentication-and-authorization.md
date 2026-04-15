# Authentication and authorization

## Keycloak OIDC (browser login)

Implemented in `server/_core/auth.ts`.

### Endpoints (under `/api/auth`)

| Method | Path | Behavior |
|--------|------|----------|
| GET | `/api/auth/login` | Redirect to Keycloak authorization URL |
| GET | `/api/auth/callback` | Exchange `code` for tokens; build `SessionUser`; set `bp_session` cookie; redirect `/` |
| POST | `/api/auth/logout` | Clears `bp_session` cookie |
| GET | `/api/auth/me` | Returns `{ user }` or 401 JSON |

### Session cookie (`bp_session`)

- **HttpOnly** cookie, `sameSite: "lax"`, `secure` in production.
- Value is a **signed JWT** (HS256) using `SESSION_SECRET` (required in production; module init throws if missing in prod).

### `SessionUser` shape

- `sub`, `email`, `name`
- `role`: coarse `"admin" | "user"` derived from realm roles (admin if realm roles include `admin`, case-insensitive)
- `realmRoles`: full list for finer checks

## tRPC authorization primitives

Defined in `server/_core/trpc.ts`.

| Export | Rule |
|--------|------|
| `publicProcedure` | No auth |
| `protectedProcedure` | Must be logged in |
| `adminProcedure` | `ctx.user.role === "admin"` |
| `analystOrAdminProcedure` | Admin **or** realm role `admin` / `analyst` (case-insensitive) |
| `appScopedProcedure` | Logged in **and** `app_members` row for `input.appId` (admins bypass) |

### Imperative helper

- `assertAppMembership(ctx, appId, { requireOwner?: boolean })` — use when the procedure input does not include `appId` directly.

## Non-tRPC auth patterns

- **Document upload** (`POST /api/agents/:agentId/documents`): requires `getUserFromRequest` and **`user.role === "admin"`** (`server/index.ts`).
- **Player UI internal API** (`GET /api/player-ui/agents`): if `PLAYER_UI_INTERNAL_TOKEN` is set, requires matching `X-Internal-Token` header; in production without token, returns 503 (`server/playerUiApi.ts`).
- **Public embed** (`/api/embed/*`, `/embed/:token`): **no user session**; gated by embed token row plus optional origin allowlist (`server/embedPublicRoutes.ts`).
