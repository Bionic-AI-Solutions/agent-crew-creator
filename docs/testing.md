# Testing

## Unit tests (`node:test`)

From the `base/` directory:

```bash
npx tsx --test tests/app-membership.test.ts
npx tsx --test tests/playground-token.test.ts
npx tsx --test tests/ensure-user-block.test.ts
npx tsx --test tests/cloudflare-dns.test.ts
npx tsx --test tests/app-membership-pglite.test.ts
```

### What these cover

- **`app-membership.test.ts`** — `assertAppMembership` behavior (admin bypass, member allow, owner requirement).
- **`playground-token.test.ts`** — LiveKit JWT shape and TTL using the same SDK calls as `playgroundRouter`.
- **`ensure-user-block.test.ts`** — Contract for binding `userId` to caller `sub` for non-admins (horizontal privilege regression guard).
- **`cloudflare-dns.test.ts`** — DNS helper behavior.
- **`app-membership-pglite.test.ts`** — Membership flows with PGlite where applicable.

## End-to-end scripts

| File | Role |
|------|------|
| `tests/e2e-regression.cjs` | Broader platform regression (see script header and root README) |
| `tests/e2e-crew-regression.cjs` | Crew and Dify-related Playwright flows |

E2E scripts typically require environment variables such as `KC_USER_PASSWORD` (see repository `README.md`).

## Integration testing

Provisioning, Vault, Kubernetes, and LiveKit behavior generally require a **live cluster and credentials**. The unit tests above mock or isolate specific modules.

## Adding tests

- Prefer `node:test` for server-side logic without pulling Jest.
- For LiveKit token shape, keep tests pinned to the same `@livekit/*` versions as production to catch SDK upgrades.
