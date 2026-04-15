# Development

## Prerequisites

- Node.js 22 or newer (aligned with `Dockerfile`)
- PostgreSQL when exercising full flows (optional for partial UI work)

## Install dependencies

```bash
cd base
npm ci
```

## Run the API and server-rendered dev flow

```bash
npm run dev
```

Runs `tsx watch server/index.ts` (see `package.json`).

## Run Vite client only

```bash
npm run dev:vite
```

## Production build

```bash
npm run build
```

Runs `scripts/guard-client-imports.sh`, Vite builds for SPA and embed, TypeScript compile for the server, and copies `server/crewTemplates` into `dist/server/`.

## Database tooling

```bash
npm run db:generate
npm run db:migrate
npm run db:push
npm run db:studio
```

## Docker

- Build from repository root with context `base/` and `Dockerfile`.
- `docker-compose.yml` in `base/` starts PostgreSQL 16 for local development.
