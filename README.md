# Agent Crew Creator

Dify-powered crew creation and management for the [Bionic AI Platform](https://platform.baisoln.com). Visual workflow builder for multi-agent crews with Letta secondary agent integration.

## Architecture

```
Bionic Platform UI
  └─ Agent Builder → Crews Tab
       └─ CrewBuilder component (embedded Dify iframe)
            ├─ Create/manage crews (name, mode, API key)
            ├─ Enable/disable crews per agent
            ├─ Crew execution history
            └─ Template gallery (5 built-in)

Execution Flow:
  Primary Agent (LiveKit) → Letta Agent → run_crew tool
    → orchestrator.py → HTTP POST to Dify workflow API
    → Dify executes workflow (Agent1 → Agent2 → ... → AgentN)
    → Results returned → Letta persists in archival memory
```

## Components

### Backend (`server/`)
- **difyAdmin.ts** — Dify REST API client, K8s manifest builder, workflow execution
- **agentRouter.ts** — tRPC endpoints: `listCrews`, `createCrew`, `deleteCrew`, `setAgentCrews`, `getDifyEmbedUrl`, `listCrewExecutions`

### Frontend (`client/`)
- **CrewBuilder.tsx** — Full crew management UI with embedded Dify editor, crew list, execution history, template gallery
- **CrewSelector.tsx** — Checkbox component for enabling/disabling crews per agent

### Agent Template (`agent-template/`)
- **main_agent.py** — LiveKit voice agent; delegates to the Letta secondary agent, which invokes crews via its server-registered `run_crew` tool
- **orchestrator.py** — _DEPRECATED / unused._ Kept only as a reference for the Dify API contract + result parsing. Crew execution is now driven by the Letta `run_crew` tool (`server/services/lettaAdmin.ts` → `buildRunCrewSourceCode()`), not this module
- **config.py** — Settings for `DIFY_BASE_URL`, `DIFY_API_KEY`, `CREW_REGISTRY`

### Database (`drizzle/`)
- **crews** table — Per-app crew registry (name, mode, Dify app ID, API key)
- **crewExecutions** table — Execution history (status, result, elapsed time, tokens)
- **agentCrews** table — Junction table linking crews to agents

### Infrastructure (`k8s/`)
- **deploy-dify.sh** — Full deployment script (namespace, PostgreSQL, MinIO, ConfigMap, all workloads, migrations, admin setup)
- **deployment.yaml** — 5 pods: dify-api, dify-worker, dify-web, dify-sandbox, dify-plugin-daemon
- **research-crew-template.yml** — Working 2-agent crew DSL (Researcher → Writer using Qwen 3.5 27B on local GPU)

### Tests (`tests/`)
- **e2e-crew-regression.cjs** — Playwright E2E tests: create 1/2/3-agent crews, enable for agent, template creation, deletion, DB verification

## Crew Workflow Design

Crews use **HTTP Request nodes** (not Dify's native LLM nodes) to call local GPU models directly. This bypasses the Dify plugin system and gives full control over the LLM API.

```yaml
Start (task, context)
  → HTTP Request: Researcher Agent (POST to vLLM /v1/chat/completions)
  → Code: Extract research text from JSON response
  → Code: Build Writer payload (JSON-safe)
  → HTTP Request: Writer Agent (POST to vLLM /v1/chat/completions)
  → Code: Extract report text
  → End (result, research)
```

### LLM Endpoints (local GPU)
- `llm-deep.mcp.svc.cluster.local:8005` — Qwen 3.5 27B (deep reasoning)
- `llm-fast.mcp.svc.cluster.local:8015` — Gemma 4 E4B (fast inference)

## Deployment

```bash
# Deploy Dify to bionic-platform namespace
cd k8s && ./deploy-dify.sh

# Or upgrade existing deployment
./deploy-dify.sh --upgrade
```

## Running Tests

```bash
# Prerequisites: Playwright installed, app + agent exist
KC_USER_PASSWORD="..." node tests/e2e-crew-regression.cjs create    # Create crews, verify
KC_USER_PASSWORD="..." node tests/e2e-crew-regression.cjs template  # Test template creation
KC_USER_PASSWORD="..." node tests/e2e-crew-regression.cjs delete    # Cleanup, verify zero remnants
KC_USER_PASSWORD="..." node tests/e2e-crew-regression.cjs all       # Full cycle
```

## Dify Version Compatibility

Tested with Dify 1.5.0. Plugin daemon 0.5.6-local required for model provider management.

| Component | Image | Port |
|-----------|-------|------|
| API | langgenius/dify-api:1.5.0 | 5001 |
| Worker | langgenius/dify-api:1.5.0 (MODE=worker) | — |
| Web | langgenius/dify-web:1.5.0 | 3000 |
| Sandbox | langgenius/dify-sandbox:0.2.10 | 8194 |
| Plugin Daemon | langgenius/dify-plugin-daemon:0.5.6-local | 5002 |
