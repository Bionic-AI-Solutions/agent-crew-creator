# Playground — full implementation plan

This document merges: **left-nav Playground**, **LiveKit agents-playground–style UX** (media + chat + settings), **App → Agent selection** for E2E testing, and **Vault-only runtime secrets** (no DB-backed LiveKit/Langfuse secrets for Playground) so tenant isolation and Langfuse routing stay correct.

**Codebase anchors:** `client` (Vite, wouter, tRPC), `server/vaultClient.ts` (`readAppSecret` → `secret/data/t6-apps/<slug>/config`), `server/services/provisioner.ts` (Vault payload shape), `agent-template` (worker `agent_name`, Langfuse via env).

---

## 1. Objectives

1. Add **Playground** to the main nav and a dedicated route where testers can **connect to a LiveKit room** and exercise **voice / video / chat** against a **selected deployed agent** for a **selected app**.
2. **Mint participant tokens** and any server-side session data using secrets **read from Vault at request time**, aligned with keys already written during provisioning (`vault_policy` step).
3. Preserve **per-app LiveKit isolation** and ensure **agent-side traces** continue to land in the **correct Langfuse project** (agent pods already get keys via ESO; Playground must not introduce a parallel secret path from the DB).
4. Reach **functional parity** with [agents-playground](https://github.com/livekit/agents-playground) for core flows: connect, publish/subscribe, chat, toggles, settings panel, clean disconnect—adapted to **Tailwind / layout** and **tRPC** backend.

---

## 2. Non-goals (initial release)

- Re-implement agents-playground in Next.js or replacing Vite.
- Storing LiveKit API secret (or Langfuse secret) in the browser or in new DB columns for Playground.
- Mobile-first responsive polish (upstream notes limited mobile support; match or document “desktop-first”).
- Full CI with a real LiveKit worker unless that already exists in pipeline (plan for optional stub + manual runbook).

---

## 3. Architecture overview

| Layer | Responsibility |
|--------|----------------|
| **Browser** | App + Agent pickers, `LiveKitRoom` / `livekit-client` connection using **URL + short-lived JWT only**. Optional safe UI: Langfuse **links** or project id surfaced from server (no secrets). |
| **bionic-platform API** | AuthZ check → load **`readAppSecret(slug)`** → validate keys present → **`livekit-server-sdk`** `AccessToken` with correct grants → return `{ token, livekitUrl, roomName, ... }`. Never return `livekit_api_secret` / `langfuse_secret_key`. |
| **Vault** | Source of truth for **`livekit_api_key`**, **`livekit_api_secret`**, **`livekit_url`**, **`langfuse_*`**, and other per-app keys already merged in provisioning. |
| **Agent worker (K8s)** | Unchanged model: ESO injects same Vault material; joins room per LiveKit dispatch; traces to Langfuse using pod env. Playground only ensures **human participant** joins the **right LiveKit project** (same keys as Vault path for that `slug`). |

**Langfuse clarification:** Session traces from the **agent** use **server-side** keys on the worker. Playground **does not** need to push traces from the browser if the goal is “see runs for this app under test”—that remains **agent + Vault**. The server may still **read** `langfuse_project_id` / public identifiers from Vault to **deep-link** the tester to the right Langfuse project UI.

---

## 4. Prerequisites & discovery (Phase 0)

### 4.1 Dispatch and room contract

- Document how a **human joins a room** and the **selected agent worker** receives a job: `agent_name` in `main_agent.py` (`WorkerOptions`), room naming, and any **LiveKit Cloud / server dispatch** rules.
- Define a **stable room name pattern** for Playground, e.g. `{roomPrefix || slug + '-'}pg-{agentId}-{shortRandom}`, and whether **metadata** must be set for dispatch.

### 4.2 Vault key contract

- Export a single **typed map** (or Zod schema) of expected keys under `t6-apps/<slug>/config`: at minimum `livekit_api_key`, `livekit_api_secret`, `livekit_url` (and confirm alignment with `k8sClient` env mapping).
- Confirm **failure** when any required key is missing (no silent fallback to `apps.apiKey` / `apiSecret`).

### 4.3 Authorization

- Reuse existing **protectedProcedure** and any **app-scoped** rules so only permitted users trigger Vault read + token mint for a given `appId`.

**Exit criteria:** Short internal doc (even a section in PR description): room name, dispatch checklist, Vault keys list, auth matrix.

---

## 5. Backend implementation

### 5.1 New tRPC router (e.g. `playgroundRouter`) or procedures on an existing router

Procedures (names illustrative):

1. **`getConnectionBundle`** (or `livekit.getPlaygroundToken`)  
   - **Input:** `appId`, `agentId`, optional `roomNameSuffix`.  
   - **Steps:** Load app (for **slug**, `roomPrefix`, enabled services) → **authorize** → **`readAppSecret(slug)`** → validate LiveKit fields → mint JWT (`roomJoin`, publish/subscribe as needed for audio/video/chat) → return `{ token, url: livekit_url, roomName, expiresAt }`.  
   - **Explicitly do not** use `apps.apiKey` / `apps.apiSecret` for this code path.

2. **`getPlaygroundMeta`** (optional but useful)  
   - **Input:** `appId`.  
   - **Output:** Non-secret metadata from Vault + DB: e.g. `langfuse_project_id`, human-readable app name, whether LiveKit is enabled—**for links and UI only**.

### 5.2 Dependencies

- Add **`livekit-server-sdk`** to `package.json` (server-side only; ensure it is not bundled into client—adjust Vite config if needed).

### 5.3 Observability

- Structured logs: `appId`, `slug`, `roomName`, `agentId`—**never** log secrets or full JWT.

### 5.4 Error handling

- Vault missing / misconfigured: clear user message.  
- Partial secrets: fail closed.

---

## 6. Frontend implementation

### 6.1 Navigation & routing

- Update `NAV_ITEMS` in `DashboardLayout.tsx`: add **Playground** (icon e.g. `FlaskConical` or `Gamepad2`).  
- Update `App.tsx`: `<Route path="/playground" component={Playground} />`.  
- Order: **Dashboard → Apps → Agent Builder → Settings → Playground** (or place Playground before Settings; pick one and keep consistent).

### 6.2 Page: `Playground.tsx`

- **App selector** (`trpc.appsCrud.list` or filtered).  
- **Agent selector** (`trpc.agentsCrud.list` with `{ appId }`), default or filter **`deployed === true`**.  
- **Connect** button → call **`getConnectionBundle`** → connect with **`@livekit/components-react`** + **`livekit-client`** (and **`@livekit/components-styles`** if used).  
- **Disconnect** and connection state (connecting / connected / error).  
- **Deployment hint:** optional strip showing deployment status from existing patterns (`DeploymentStatus` or lightweight query) so testers do not pick undeployed agents.

### 6.3 Feature parity (agents-playground)

- Audio/video publish and subscribe, **chat** channel if the agent uses data/text (match reference patterns).  
- **Settings / device** controls: mirror reference where feasible (mic/camera/speaker selection).  
- **Layout:** full-height column for the room; adjust padding so `DashboardLayout` main area does not clip video (Playground page may use `h-[calc(100vh-...)]` or negative margin—follow the design system).

### 6.4 Client dependencies

- Add: `@livekit/components-react`, `@livekit/components-core`, `@livekit/components-styles`, `livekit-client` (versions aligned with agents-playground or latest compatible—pin together).

---

## 7. Vault-first policy (hard requirements)

- **Single read path** for LiveKit minting: **`readAppSecret(slug)`** only.  
- **No** returning Langfuse **secret** to the client; **no** storing Vault payload in React state beyond ephemeral **connection** fields.  
- Optional follow-up (separate task): deprecate or stop relying on **`apps.apiKey` / `apiSecret`** for *any* new features and migrate old callers to Vault for consistency.

---

## 8. Testing & quality

| Type | Scope |
|------|--------|
| **Unit** | Token procedure: rejects wrong `appId`/`agentId`, rejects missing Vault keys, never calls DB for LiveKit secret; mock `readAppSecret`. |
| **Integration** | With Vault + LiveKit dev stack: connect once, verify room join (manual or scripted). |
| **E2E (Playwright)** | Login → Playground → select app/agent → mock **`getConnectionBundle`** or use test project → assert UI states (connected / disconnected). |
| **Manual runbook** | Select app → verify Langfuse project link (if implemented) → run voice session → confirm trace in correct Langfuse project. |

---

## 9. Security checklist

- [ ] JWT **short TTL** (e.g. 5–15 minutes).  
- [ ] **RBAC** on every procedure that reads Vault.  
- [ ] **Rate limiting** (optional): cap token mints per user/app if abuse is a concern.  
- [ ] **Audit**: log access to Playground token endpoint (without secrets).

---

## 10. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Dispatch mismatch (agent never joins) | Phase 0 doc + test with one known app; adjust room metadata or server dispatch APIs. |
| Vault latency | Acceptable for interactive testing; avoid caching secrets. |
| Drift between DB `apps` and Vault | Vault-only path for Playground; long-term align provisioning to single source. |
| Bundle size | Lazy-load Playground route + LiveKit chunks if needed. |

---

## 11. Rollout sequence (recommended)

1. **Phase 0** — Discovery + contracts.  
2. **Phase 1** — Backend: Vault read + mint + tests.  
3. **Phase 2** — Nav + empty Playground page + wire **connect/disconnect** with real token.  
4. **Phase 3** — App/Agent selectors + deployment awareness.  
5. **Phase 4** — Chat + settings/device parity with agents-playground.  
6. **Phase 5** — Langfuse **links/meta** from Vault (optional UX).  
7. **Phase 6** — E2E + docs + runbook.

---

## 12. Deliverables

- Working **Playground** route and nav entry.  
- **tRPC** (or equivalent) **Vault-backed** LiveKit token API.  
- **React** session UI using official LiveKit components.  
- **Tests** as in §8.  
- **Internal doc**: room naming, dispatch, Vault keys, manual verification steps.

---

## 13. Open items to resolve during Phase 0

- Exact **LiveKit token grants** (publish video vs audio-only defaults) per agent capabilities (`vision_enabled`, `avatar_enabled`, etc.).  
- Whether **multiple agents** per app require **explicit dispatch** beyond room name.  
- Whether to add **`implementation-tracker.md`** under `docs/feature/playground/` and a **git branch** per org process when implementation starts.

---

## References

- [livekit/agents-playground](https://github.com/livekit/agents-playground) — UI and interaction patterns.  
- [LiveKit Agents docs](https://docs.livekit.io/agents) — worker and dispatch behavior.
