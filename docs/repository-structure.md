# Repository structure (`base/`)

```
base/
├── package.json              # npm scripts, dependencies
├── Dockerfile                # Multi-stage: Vite build + Node runner (tsx)
├── docker-compose.yml        # Local Postgres (optional dev DB)
├── vite.config.ts            # SPA build
├── vite.embed.config.ts      # Embed bundle build
├── tsconfig*.json
├── drizzle/                  # Drizzle schema + migrations
│   ├── platformSchema.ts     # Primary tables (apps, agents, crews, …)
│   ├── relations.ts
│   └── schema.ts             # Re-exports platform + relations
├── server/                   # Express + tRPC backend
│   ├── index.ts              # Express wiring, Dify proxy, uploads
│   ├── db.ts                 # PostgreSQL pool + Drizzle init
│   ├── routers.ts            # Root tRPC router composition
│   ├── appRouter.ts          # Apps CRUD + provisioning job queries
│   ├── agentRouter.ts        # Agents, tools, crews, MCP, Dify helpers
│   ├── playgroundRouter.ts   # LiveKit playground tokens
│   ├── embedRouter.ts        # Admin CRUD for embed tokens
│   ├── embedPublicRoutes.ts  # Public embed + s3-proxy
│   ├── playerUiApi.ts        # Internal GET for player-ui pods
│   ├── vaultClient.ts        # Vault KV v2 HTTP client
│   ├── k8sClient.ts          # Namespace, deployments, LiveKit ESO, …
│   ├── _core/
│   │   ├── auth.ts           # Keycloak + session JWT
│   │   ├── trpc.ts           # Procedures + app membership helpers
│   │   └── logger.ts
│   └── services/             # Admins and domain services
├── client/                   # React SPA
│   └── src/
│       ├── App.tsx           # Routes + auth gate
│       ├── pages/            # Dashboard, Apps, AgentBuilder, Playground, …
│       ├── components/       # UI + feature components
│       ├── embed/            # Embed widget client sources
│       └── lib/trpc.ts       # tRPC client setup
├── player-ui/                # Template / build context for per-app player UI
├── agent-template/           # Python Letta/LiveKit worker image sources
├── shared/
│   └── provisioningTypes.ts  # ServiceKey union + labels
├── tests/                    # node:test unit tests + Playwright CJS scripts
├── scripts/                  # Guard scripts, setup helpers
├── docs/                     # This documentation set
└── k8s/                      # Reference manifests + deploy-dify.sh
```

## Naming conventions

- **App slug**: lowercase kebab-case; used as the Kubernetes namespace name when Kubernetes is enabled.
- **Agent `name`**: unique within an app; the deployed worker uses dispatch name `${slug}-${agent.name}` for LiveKit (`server/services/agentDeployer.ts`, `server/playgroundRouter.ts`).
