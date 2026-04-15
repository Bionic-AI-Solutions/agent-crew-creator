# tRPC API

## Entry

- **HTTP path**: `/trpc`
- **Router composition**: `server/routers.ts` exports `appTrpcRouter`:

```ts
appsCrud: appRouter
agentsCrud: agentRouter
playground: playgroundRouter
embed: embedRouter
userSession: { me: publicProcedure ... }
```

## Client usage

- Browser code uses `@trpc/react-query` from `client/src/lib/trpc.ts`.

## Major namespaces

### `appsCrud` (`server/appRouter.ts`)

- List, get, create, update apps; provisioning job queries
- Admin-only create; membership checks on reads; owner-only updates where enforced

### `agentsCrud` (`server/agentRouter.ts`)

Large surface area, including:

- Agent CRUD, deploy, status
- Tools, MCP servers, custom tools
- Crews (Dify), executions, templates
- Provider key test and save (Vault)
- User memory blocks (Letta), including binding `userId` to caller `sub` for non-admins on `ensureUserBlock`

### `playground` (`server/playgroundRouter.ts`)

- `getMeta` — app-scoped LiveKit readiness from Vault
- `getConnectionBundle` — mint LiveKit JWT with `RoomAgentDispatch` for worker autodispatch

### `embed` (`server/embedRouter.ts`)

- Protected CRUD for `embed_tokens` per agent

### `userSession`

- `me` returns `{ user: ctx.user }` (nullable user)

## Type export

- `export type AppRouter = typeof appTrpcRouter` in `server/routers.ts` enables typed clients.

## Discovering every procedure

Procedure names are defined in each router file. For a full inventory, search for `:` definitions under `server/*Router.ts`, or introspect the running server with tRPC tooling. The largest router is `server/agentRouter.ts`.
