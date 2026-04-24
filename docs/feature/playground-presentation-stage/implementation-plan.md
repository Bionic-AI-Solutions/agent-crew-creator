# Implementation Plan: Playground Presentation Stage

## Overview
Restore the prior classroom-style behavior inside the current Playground: the primary voice agent continues teaching while Letta-generated support material appears on a central presentation stage.

## Requirements
- Reuse the existing LiveKit `lk.chat` stream and embedded artifact JSON format.
- Support split support channels: `lk.chat.summary` for talking points and `lk.chat.presentation` for visual/display material.
- Render images centrally with presentation-friendly sizing and centering.
- Render markdown/text support material as slide-style content.
- Keep the right-side transcript/output history available.
- Keep Letta research off the primary voice path so the primary agent can keep talking naturally.
- Nudge the primary agent with concise categorized points after Letta finishes, rather than forcing it to read long research verbatim.
- Make support-generation tools reusable for any persona, including teaching, storytelling, consulting, and coaching agents.
- Use exact live MCP tool names for generated images, PDFs, and email delivery.
- Avoid reintroducing the removed `player-ui` implementation or duplicate artifact parsing.

## User Journey
1. The primary agent greets the user when they join and begins a natural voice dialog.
2. Based on the persona and conversation, the primary agent may delegate deeper research to Letta.
3. Letta runs in parallel while the primary agent keeps talking.
4. Letta returns categorized research/talking points for the primary agent and presentation-ready material for the UI.
5. The Playground shows visual material on the central presentation screen, including centered generated images.
6. The primary agent uses the concise talking points as background and explains them naturally without reading long research dumps.

## Implementation Phases
1. Document and inspect the old classroom flow and current Playground artifact renderer.
2. Extract artifact parsing/rendering into shared local helpers inside `Playground.tsx`.
3. Add a central stage that selects the latest renderable artifact/text support item.
4. Remove redundant inline artifact parsing from the side panel.
5. Restore background Letta delegation and split summary/presentation publication in the agent template.
6. Register reusable Letta support tools for image generation and PDF/email delivery during agent deploy.
7. Validate with Dockerized frontend, server TypeScript, Python syntax, and agent image checks.

## MCP Tool Mapping
- GenImage: `gi_generate_image` via `mcp-genimage-server.mcp.svc.cluster.local:8008/mcp`.
- PDF: `pdf_generate_pdf` via `mcp-pdf-generator-server.mcp.svc.cluster.local:8003/mcp`.
- Mail: `mail_send_email_with_attachments` via `mcp-mail-server.mcp.svc.cluster.local:8005/mcp`.

## Testing Strategy
- Unit-level coverage is limited because Playground currently has no component tests.
- Build verification: `docker build --platform linux/amd64 --target frontend-builder`.
- Type verification: `npx tsc --noEmit` and server TypeScript check inside the x86 image.
- Agent verification: Python syntax check and agent-template Docker build.
- Smoke verification after deploy: `/playground` route returns `200`.

## Rollout
Deploy with the existing `docker4zerocool/bionic-platform:latest` image and Kubernetes rollout restart for `bionic-platform`.
