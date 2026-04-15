# HTTP and Express routes (non-tRPC)

Most wiring lives in `server/index.ts`. Public embed routes are registered from `server/embedPublicRoutes.ts`.

## Global middleware

- **JSON body parser**: `express.json({ limit: "1mb" })` is applied before embed routes. Use route-local limits for endpoints that need larger bodies.
- **CORS**: In production, origins are `https://platform.baisoln.com` and `https://platform.bionicaisolutions.com`. In development, `origin: true`. Credentials are enabled for authenticated flows.

## Route table

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| * | `/api/embed/*` | Public (per-route CORS) | Embed preflight and APIs (`embedPublicRoutes.ts`) |
| POST | `/api/embed/connection-details` | Embed token | Mint LiveKit visitor token and room |
| GET | `/api/s3-proxy/:bucket/*` | Public | Proxy presigned MinIO image fetch |
| GET | `/api/embed/widget.js` | Public | Serve built embed script |
| GET | `/embed/:embedToken` | Public | HTML shell for iframe embed |
| GET | `/healthz` | Public | Liveness `{ status: "ok" }` |
| POST | `/api/webhooks/notify` | `X-Bionic-Token` when configured | Notify dispatcher (`notifyService.ts`) |
| GET | `/api/player-ui/agents` | Internal token in prod | Agent list for player-ui pods (`playerUiApi.ts`) |
| * | `/api/auth/*` | Mixed | Keycloak OAuth (`auth.ts`) |
| * | `/trpc` | Session for protected | tRPC |
| POST | `/api/agents/:agentId/documents` | Admin session | Multer upload, MinIO, Letta passages |
| * | `/dify/console/api`, `/dify/api`, `/dify/v1` | Deployment-dependent | Reverse proxy to Dify API |
| GET | `/dify-login` | Unauthenticated in code | Dify auto-login; treat as high risk if exposed |
| * | `/_next`, `/vs`, `/logo`, `/embed*.js` | Public | Dify static asset proxy |
| * | `/dify/*` | Mixed | Dify web UI; strips `X-Frame-Options` for iframe |
| GET | `*` | Public | SPA fallback to `index.html` |

## Dify proxy

- Targets in-cluster `dify-api` and `dify-web` in namespace `bionic-platform` (`server/index.ts`).
- Web proxy sets `ws: true` for websocket upgrade (Dify Next.js).

## Static files

- `express.static` serves `dist/public` relative to the server bundle location.
