# Adversarial Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 35 findings from the 2026-07-13 adversarial code review of `agent-crew-creator`, in order of criticality, each with a regression test, and clean up the orphaned production resources that the pre-existing bugs left behind.

**Architecture:** Fixes are grouped by criticality (Critical → High → Medium → Low). Each code fix ships with a regression test (unit test via `npx tsx --test` for pure logic; integration test against real infra where the fix touches Postgres/Letta/K8s/Vault, per the project's "no mocks for integration" rule). A dedicated infra-cleanup phase runs *after* the deletion-path bugs are fixed, so cleanup scripts reuse the now-correct delete code instead of duplicating logic.

**Tech Stack:** Node/TypeScript (tRPC + Express server, React/Vite client), Python (LiveKit agent-template), Drizzle ORM + Postgres, Redis, Vault, MinIO, Keycloak, Cloudflare, Kubernetes. Tests: Node built-in test runner via `tsx` (`npx tsx --test <file>`). Markdown: `marked` v14.

## Global Constraints

- **No skipped tests.** Every fix ships with a passing regression test in the same change. `marked` stays at v14 (already a dependency).
- **Integration tests hit real infra**, never mocks — real Postgres (pglite is acceptable only where the existing suite already uses it for SQL-predicate tests), real Letta/K8s/Vault where reachable. Unit tests may isolate pure logic.
- **No hardcoded secrets.** Secrets flow Vault → ESO → K8s. New env reads route through `server/config.ts` where a shared accessor exists.
- **No `--no-verify`, no `--no-gpg-sign`, no force-push to main.** Work happens on a feature branch.
- **Sanitizer libraries:** add `sanitize-html` (server-side email/HTML) and `dompurify` (client-side React) rather than hand-rolled regex.
- **DB/infra cleanup is dry-run first:** list what would be deleted, surface it, then delete. Cleanup targets only resources with no corresponding live DB row.

---

## Phase 0 — Setup

### Task 0.1: Working branch + dependencies

**Files:**
- Modify: `package.json` (add `sanitize-html`, `@types/sanitize-html`, `dompurify`, `@types/dompurify`)

- [ ] Create branch `fix/adversarial-review-remediation` off `main`.
- [ ] `npm install --save sanitize-html dompurify` and `npm install --save-dev @types/sanitize-html @types/dompurify`.
- [ ] Verify `npm run build` still succeeds (baseline green before any fix).
- [ ] Commit: `chore: add sanitize-html + dompurify for XSS remediation`.

---

## Phase 1 — CRITICAL

### Task 1.1 (Finding #1): Letta agents/memory are never deleted

**Root cause:** `agentRouter.delete` (`server/agentRouter.ts:536-562`) never calls any Letta cleanup. `lettaAdmin.deleteAgent` has zero callers. `lettaAdmin.deleteTenant` (`lettaAdmin.ts:76-87`) filters agents by `name.startsWith(slug)`, but real names are `${slug}-letta-${uuid}` / `${agentName}-letta`, so on a per-agent delete there is no `slug` in scope and app-level delete only coincidentally matches slug-prefixed names.

**Files:**
- Modify: `server/agentRouter.ts:536-562` (delete mutation)
- Modify: `server/services/lettaAdmin.ts` (ensure `deleteAgent(agentId)` deletes agent + its blocks; export used)
- Test: `tests/letta-agent-delete.test.ts` (new)

**Fix:**
1. In `agentRouter.delete`, after `assertAppMembership` and before the DB row delete, if `agent.lettaAgentId` is set, call `await lettaAdmin.deleteAgent(agent.lettaAgentId)` inside a `try/catch` that logs but does not abort the DB delete (so a dead Letta server can't wedge agent deletion — but the attempt is always made).
2. Also delete any per-agent user blocks / MCP registrations created in the deploy path (cross-reference `deleteUserBlock` and MCP registration in `agentRouter`/`lettaAdmin`).
3. `deleteTenant(slug)`: keep as app-level sweep but make it delete by matching `lettaAgentId`s of the app's agents (query DB for the app's agents, delete each by id) rather than by fragile name prefix.

**Test (unit, logic-level):** assert that given an agent row with `lettaAgentId`, the delete mutation invokes `lettaAdmin.deleteAgent(lettaAgentId)` exactly once (spy), and that a thrown Letta error does not prevent the DB delete. Because the mutation is tRPC, test the extracted deletion helper directly (refactor the Letta-cleanup step into an exported `cleanupLettaForAgent(agent)` function so it is unit-testable without standing up tRPC).

- [ ] Write failing test asserting `deleteAgent(lettaAgentId)` is called and DB-delete still runs on Letta failure.
- [ ] Run → fails.
- [ ] Implement `cleanupLettaForAgent` + wire into `delete` mutation + fix `deleteTenant`.
- [ ] Run → passes.
- [ ] Commit: `fix(letta): delete Letta agent + memory on agent/app deletion (was orphaned forever)`.

### Task 1.2 (Finding #2): Unauthenticated email-injection relay

**Root cause:** `POST /api/session-summary/send` (`server/index.ts:47-54`) has no auth; `renderSummaryHtml` (`sessionSummaryService.ts:44,49-52`) injects `summaryMarkdown` (via `marked.parse`) and `imageUrls` `src=` unescaped.

**Files:**
- Modify: `server/index.ts:47-54` (add shared-token auth guard like `/api/webhooks/notify`)
- Modify: `server/services/sessionSummaryService.ts:39-96` (sanitize `bodyHtml`, validate/whitelist `imageUrls`)
- Modify: `server/services/notifyService.ts` (reuse its `X-Bionic-Token` validation, or extract a shared `verifyInternalToken(req)`)
- Test: `tests/session-summary-auth.test.ts` (new)

**Fix:**
1. Extract the internal-token check used by `handleNotifyWebhook` into a reusable `verifyInternalToken(req): boolean` (reads `X-Bionic-Token` / `AGENT_INTERNAL_TOKEN`). Gate `/api/session-summary/send` on it — return 401 when absent/mismatched. Fail closed in production if the token env is unset (match `playerUiApi.ts` behavior).
2. In `renderSummaryHtml`, run `bodyHtml = sanitizeHtml(marked.parse(summaryMarkdown), { allowedTags, allowedAttributes })` — allow only formatting tags, no `<script>`, no event handlers, `href`/`src` restricted to `http/https/mailto` + the known S3 hosts.
3. `imageUrls`: filter to `https?://` URLs on an allowlist of known hosts (S3 proxy host, platform host) before emitting `<img src>`.

**Test:** unit — (a) request without token → helper returns false / route would 401; (b) `renderSummaryHtml({summaryMarkdown:'<img src=x onerror=alert(1)>'})` output contains no `onerror` and no raw `<script>`; (c) a `javascript:` image URL is dropped.

- [ ] Write failing tests (auth-missing rejected; payload sanitized).
- [ ] Run → fails.
- [ ] Implement token guard + sanitization + URL allowlist.
- [ ] Run → passes.
- [ ] Commit: `fix(security): authenticate + sanitize session-summary email endpoint (was open HTML relay)`.

### Task 1.3 (Finding #3 + #11): Unsanitized `dangerouslySetInnerHTML` (Playground + embed widget)

**Root cause:** `Playground.tsx:184-198` pipes `marked.parse(agentOutput)` straight into `dangerouslySetInnerHTML`. `embed/ChatMessage.tsx:8-23` uses a regex sanitizer bypassable by unquoted attributes.

**Files:**
- Create: `client/src/lib/sanitizeHtml.ts` (wraps DOMPurify with the app's allowlist + integrates `rewriteS3UrlsInHtml`)
- Modify: `client/src/pages/Playground.tsx:184-198`
- Modify: `client/src/embed/ChatMessage.tsx:8-23,145-148,220-225` (replace regex `sanitizeHtml` with DOMPurify)
- Test: `tests/client-sanitize.test.ts` (new; DOMPurify runs under jsdom or via `dompurify` with a `linkedom`/`jsdom` window — use the same test harness the repo already supports, else test the pure allowlist transform)

**Fix:** central `sanitizeRichText(markdownHtml: string): string` = `DOMPurify.sanitize(marked.parse(x), { ALLOWED_TAGS, ALLOWED_ATTR, FORBID_ATTR: ['onerror','onload',...] })` then `rewriteS3UrlsInHtml`. Replace both call sites and delete the regex sanitizer.

**Test:** `sanitizeRichText('<img src=x onerror=alert(1)>')` → no `onerror`; `'<svg onload=alert(1)>'` → stripped; `'[link](javascript:alert(1))'` → no `javascript:` href; a legit `**bold**` + S3 image survives and gets rewritten.

- [ ] Write failing tests for the three XSS vectors + one positive case.
- [ ] Run → fails.
- [ ] Implement `sanitizeRichText`, wire both call sites, delete regex sanitizer.
- [ ] Run → passes; `npm run build` green.
- [ ] Commit: `fix(security): DOMPurify-sanitize agent HTML in playground + embed widget (XSS)`.

### Task 1.4 (Finding #4): LiveKit rollback resurrected by ESO

**Root cause:** `provisioner.ts:277-281` rollback only calls `k8s.removeLivekitKey` (direct Secret edit, `@deprecated`, reverted by ESO). Vault entry + ESO template line written by `registerAppLivekitKey` (`k8sClient.ts:224-265`) are left in place.

**Files:**
- Modify: `server/services/provisioner.ts:277-281` (`ROLLBACK_STEPS.livekit`)
- Modify: `server/k8sClient.ts` (ensure a `deregisterAppLivekitKey(slug)` exists that removes the Vault key + strips the ESO template line — mirror `registerAppLivekitKey`; the correct full-deletion path at `provisioner.ts:545-599` already does this, so extract/reuse it)
- Test: `tests/livekit-rollback.test.ts` (new — unit against the template-manipulation logic)

**Fix:** rollback calls the same Vault+ESO deregistration used by the app-deletion path (`deregisterAppLivekitKey(ctx.slug)`), not the deprecated direct-Secret edit.

**Test:** unit — given an ESO template containing `slug`'s line, `deregisterAppLivekitKey` produces a template without it and issues the Vault delete for `t6-apps/livekit/config` key. (Mock only the Vault/K8s transport; assert the exact calls — this is transport-boundary, not business logic, so a call-assertion unit test is appropriate. A real-infra integration variant is deferred to Phase 4 verification against the cluster.)

- [ ] Write failing test (rollback must call Vault delete + template strip, not just Secret edit).
- [ ] Run → fails.
- [ ] Implement rollback via `deregisterAppLivekitKey`.
- [ ] Run → passes.
- [ ] Commit: `fix(provisioning): livekit rollback removes Vault+ESO entry (ESO no longer resurrects key)`.

---

## Phase 2 — Infra / DB Cleanup (dry-run → delete)

Runs after Phase 1 so it reuses the corrected delete code. Each is a script under `scripts/cleanup/` that lists orphans (no live DB row), prints them, and deletes only on `--apply`.

### Task 2.1: Orphaned Letta agents
- [ ] `scripts/cleanup/orphaned-letta-agents.ts`: `GET /v1/agents/`, cross-reference every agent id against `agentConfigs.lettaAgentId` in Postgres. Any Letta agent whose id is absent from the DB (and whose name matches the `*-letta*` convention) is an orphan.
- [ ] Run without `--apply` → print count + names/ids. Surface to user.
- [ ] Run with `--apply` → delete via `lettaAdmin.deleteAgent`. Record deleted ids.

### Task 2.2: Orphaned K8s ConfigMaps (Finding #7)
- [ ] `scripts/cleanup/orphaned-agent-configmaps.ts`: list `*-config` ConfigMaps in each app namespace, cross-reference against live agent names in DB. Delete orphans on `--apply`.

### Task 2.3: Orphaned Langfuse projects (Finding #8)
- [ ] `scripts/cleanup/orphaned-langfuse-projects.ts`: list Langfuse projects, cross-reference against `apps.langfuseProjectId` (or equivalent). Delete orphans on `--apply`.

### Task 2.4: Orphaned MinIO buckets / service accounts (Finding #18)
- [ ] `scripts/cleanup/orphaned-minio.ts`: list buckets + service accounts matching the app-slug convention, cross-reference against live app slugs. Delete orphans on `--apply`.

### Task 2.5: Orphaned Vault LiveKit keys (Finding #4 fallout)
- [ ] `scripts/cleanup/orphaned-livekit-keys.ts`: read `t6-apps/livekit/config`, cross-reference key names against live app slugs. Remove orphan keys + strip ESO template lines on `--apply`.

**Gate:** present the full dry-run inventory to the user before any `--apply`. (Per CLAUDE.md, shared-infra destructive writes are authorized here because the user explicitly requested DB cleanup, but the inventory is surfaced first.)

---

## Phase 3 — HIGH

- **Task 3.1 (Finding #5):** `server/index.ts:126-132` document upload — replace global-admin gate with `assertAppMembership(ctx, appId)` semantics (resolve appId from `agentId`, verify caller is app member). Test: member (non-global-admin) upload succeeds; non-member 403.
- **Task 3.2 (Finding #6):** `postgresAdmin.createDatabase:20-59` — on "already exists", run `ALTER ROLE ... PASSWORD` to reconcile to the returned password (idempotent), OR fetch-and-return the existing credential. Test (pglite/real PG): calling twice yields a password that actually authenticates.
- **Task 3.3 (Finding #7):** `agentDeployer.undeployAgent` / `k8sClient.deleteAgentDeployment:644-653` — also delete the `${agentName}-config` ConfigMap. Test: after undeploy, ConfigMap is gone (integration against cluster, or assert the delete call is issued).
- **Task 3.4 (Finding #8):** `langfuseAdmin.createProject:57-109` — wrap both inserts in a transaction; validate `LANGFUSE_SALT` before the first insert. Test: missing salt → no `projects` row committed.
- **Task 3.5 (Finding #9):** `shared/providerOptions.ts` — remove `letta`/`faster-whisper` from selectable options (they're unimplemented), OR implement them. Decision: remove from options (YAGNI) unless there's a live agent using them. Test: every option in `providerOptions` has a matching entry in `llmProviders`/`voiceProviders`.
- **Task 3.6 (Finding #10):** `AgentConfigForm.tsx:43-63` — guard the resync effect so it does not clobber unsaved edits: track a `dirty` flag (or seed local state only when `agent.id` changes / on first load), not on every `getById` data identity change. Test: RTL — type in a field, trigger a sibling query invalidation, assert the typed value persists.
- **Task 3.7 (Finding #12):** `agent-template/src/agent/main_agent.py:605` — make the delegation retry idempotent (dedupe key / don't re-POST after client-side timeout, or make the timeout not abandon-then-retry). Test: simulate >10s response → assert single POST / single side effect.
- **Task 3.8 (Finding #13):** `player-ui/components/AgentApp.tsx:401` — `toggleScreen()` off-path must call `setScreenShareEnabled(false)`. Test: toggling off disables the track.
- **Task 3.9 (Finding #14):** `player-ui/components/AgentApp.tsx:123` — include `clientId` in `connect` deps (or read from ref). Test: changing client ref before connect uses the new value.
- **Task 3.10 (Finding #15):** `tests/e2e-crew-regression.cjs:478` + `tests/e2e-regression.cjs` — remove the per-phase `process.exit()` so `runAll()` actually chains create→template→delete. This is a test-infrastructure fix; verify `all` runs all phases.

---

## Phase 4 — MEDIUM

- **Task 4.1 (Finding #16):** `embedPublicRoutes.ts:174-181` — enforce `allowedOrigins` even when `Origin` header is absent (reject if allowlist set and no matching origin). Test: no-Origin request against a restricted token → 403.
- **Task 4.2 (Finding #17):** `embedPublicRoutes.ts:287-392` s3-proxy — bind object access to the embed token / app scope (verify the requested key belongs to the token's app), don't serve arbitrary keys. Test: cross-app key → 403.
- **Task 4.3 (Finding #18):** `provisioner.ts:297-300` — MinIO rollback must propagate failure (remove empty catches or re-throw) so step status reflects reality. Test: forced delete failure → step not marked `rolled_back`.
- **Task 4.4 (Finding #19):** `provisioner.ts:135-144` — stop copying platform-wide `LETTA_API_KEY` into each tenant secret; issue/scoped key per tenant if Letta supports it, else document + isolate. Decision recorded in plan; minimal fix: don't write the shared key into per-tenant Vault path. Test: tenant secret does not contain the platform key.
- **Task 4.5 (Finding #20):** `redisAdmin.testConnectivity:22-26` — actually `PING`/`SET`/`GET` against Redis. Test (real Redis): unreachable URL → returns false.
- **Task 4.6 (Finding #21):** `pdfReport.renderCode:391-411` — recompute `startY` after the `ensureSpace` page-break check. Test: code block near page bottom renders at the new page top.
- **Task 4.7 (Finding #22):** `notifyService.ts:122-141` — resolve AAAA too, reject private IPv6; pin the resolved IP for the fetch (or use an SSRF-safe agent) to close the rebind TOCTOU. Test: AAAA-only private host → blocked.
- **Task 4.8 (Finding #23):** `playerUiCodegen.ts:39-77` — wrap temp-dir setup in try/catch that removes the dir on failure. Test: forced writeFile failure → temp dir removed.
- **Task 4.9 (Finding #24):** `player-ui/app/api/livekit/token/route.ts:16` — add token refresh (issue shorter TTL + refresh endpoint, or handle reconnect re-mint). Test: expiry path re-mints.
- **Task 4.10 (Finding #25):** `tests/ensure-user-block.test.ts` + `tests/app-membership.test.ts` — rewrite to exercise the real guard/SQL (pglite for the membership predicate, real `agentRouter` guard import for the block test) instead of reimplementations/fake chains. Test: mutating the real guard breaks the test.
- **Task 4.11 (Finding #26):** `agent-template/README.md` — remove/mark `orchestrator.py` as deprecated; document the actual live path. Docs-only.
- **Task 4.12 (Finding #27):** `agent-template/src/agent/main_agent.py:27` — remove the dead monkeypatch and set the timeout via the supported per-consumer `ConnectOptions` at each call site. Test: a call uses the 120s connect option.

---

## Phase 5 — LOW

- **Task 5.1 (Finding #28):** `server/config.ts` — actually import from it in the drifted consumers (start with `lettaAdmin.ts` `LETTA_BASE_URL` default). Test: `config.ts` value used.
- **Task 5.2 (Finding #29):** `auth.ts:261` — `await revokeSessionToken(...)` before responding. Test: revoke completes before 200.
- **Task 5.3 (Finding #30):** `auth.ts:194-203` — reject when `azp` absent (defense-in-depth) unless a legitimate no-`azp` flow exists. Test: token without `azp` rejected.
- **Task 5.4 (Finding #31):** `embedPublicRoutes.ts:93-96` — delete dead `isRateLimited()`. Docs/dead-code.
- **Task 5.5 (Finding #32):** `mailer.ts:18-39` — don't cache a rejected transporter promise; retry on next call. Test: first failure then success re-inits.
- **Task 5.6 (Finding #33):** `useAuth.ts:13` — `isAdmin` includes `super_admin`. Test: `super_admin` → `isAdmin true`.
- **Task 5.7 (Finding #34):** `DocumentUpload.tsx:97` — either add `chunkCount` to the shared type + server return, or drop the badge. Align type with reality.
- **Task 5.8 (Finding #35):** `tests/e2e-release.cjs:153` — replace hardcoded `ok(name, true)` with real assertions on the preceding action.

---

## Phase 6 — Verification

- [ ] `npm run build` green (client + embed + server tsc).
- [ ] Run every `tests/*.test.ts` via `npx tsx --test` — all pass, none skipped.
- [ ] Run the corrected e2e regression `all` flow against real infra where reachable (create→template→delete, verifying zero remnants).
- [ ] Re-run the Phase 2 cleanup dry-runs → confirm zero orphans remain.
- [ ] Push branch, open PR (do not merge to main without explicit instruction).

## Self-Review notes

- Every one of the 35 findings maps to a task (Findings #1-4 → Phase 1; #5-15 → Phase 3; #16-27 → Phase 4; #28-35 → Phase 5; the orphan-cleanup consequences of #1/#4/#7/#8/#18 → Phase 2).
- Deletion-path fixes (#1, #7) precede their cleanup scripts (2.1, 2.2) so cleanup reuses corrected code.
- Sanitizer choice is uniform: `sanitize-html` server, `dompurify` client — no hand-rolled regex survives.
