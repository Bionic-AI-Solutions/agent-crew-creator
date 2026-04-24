# Scratchpad: Playground Presentation Stage

## Findings
- Active Playground uses `LiveKitRoom`, `useVoiceAssistant`, `useChat`, `useTranscriptions`, and inline `SecondaryAgentMessage` parsing in `client/src/pages/Playground.tsx`.
- Letta support material is already delivered through LiveKit chat messages on `lk.chat`.
- The previous classroom behavior was in removed `player-ui/components/AgentApp.tsx` at commit `498e7a7`.
- The old UI separated content into a central presentation area and a right chat/summary panel.
- The repository already has a `show_artifact` concept in prompts/tool registry, but the active runtime path currently depends on embedded JSON artifact blocks inside Letta chat output.

## Strategy
- Do not re-add `player-ui`.
- Keep a single parser for Letta message segments.
- Feed central presentation and side history from the same parsed data.
- Prefer current shadcn/Tailwind UI patterns over old inline style objects.

## Attempts
- Created branch `feature/playground-presentation-stage`.
- Created feature docs folder and plan/tracker.
- Implemented shared Letta support parsing in `client/src/pages/Playground.tsx`.
- Replaced duplicate side-panel parsing with `SupportMessage` fed by parsed segments.
- Added `PresentationStage`, which uses the latest renderable support segment as the active lecture-screen item.
- Ran Dockerized frontend production build and TypeScript checks successfully.
- Updated Playground to subscribe to `lk.chat.summary` and `lk.chat.presentation` via `useTextStream`, while preserving legacy `lk.chat` parsing.
- Updated `agent-template/src/agent/main_agent.py` so `delegate_to_letta` returns immediately, runs Letta work in the background, publishes categorized summary and presentation streams, and nudges the primary agent with concise talking points.
- Ran Python syntax check for `agent-template/src/agent/main_agent.py`.

## Verification
- Pass: `docker build --platform linux/amd64 --target frontend-builder -t agent-crew-creator-presentation-stage:check .`
- Pass: `docker run --rm --platform linux/amd64 --entrypoint sh agent-crew-creator-presentation-stage:check -lc "npx tsc --noEmit && npx tsc -p tsconfig.server.json --noEmit"`
- Pass: `python3 -m py_compile agent-template/src/agent/main_agent.py`
- Pass: `docker build --platform linux/amd64 -t agent-crew-creator-agent-template:check .` from `agent-template/`
- Not run: E2E scripts require live credentials and resource creation/deletion.
