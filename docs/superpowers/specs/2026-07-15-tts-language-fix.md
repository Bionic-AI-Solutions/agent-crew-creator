# Sarvam TTS language selection — fix

**Status:** Approved (fast-tracked — live bug blocking active user testing)
**Date:** 2026-07-15

## Root cause

Found live: an agent ("Neha," a Hindi-speaking loan-application assistant, `agent-fedfina` in the `guruji` app) configured with `ttsProvider=sarvam` was synthesizing genuinely Hindi/Devanagari LLM output (e.g. `"नमस्ते! मैं नेहा हूँ..."`) but sounding wrong. Pod logs confirmed every Sarvam TTS call sent `"target_language_code": "en-IN"` — Sarvam's TTS API requires this parameter (one of 11 real Indic codes or `en-IN`; no auto-detect exists in the installed `livekit-plugins-sarvam==1.6.5`), and this integration never exposed it anywhere in the stack — `agent-template/src/agent/plugins.py`'s `sarvam.TTS(...)` call silently relied on the plugin's own default (`en-IN`) regardless of what language the actual text was in.

## Fix

Add `ttsLanguage` as a new nullable column (default `"en-IN"`, backward-compatible with every existing agent), threaded the same way `ttsVoice` already is: DB → ConfigMap → `config.py` → `plugins.py`'s `sarvam.TTS(target_language_code=...)`. UI exposes all 11 Sarvam-supported languages (`bn-IN`, `en-IN`, `gu-IN`, `hi-IN`, `kn-IN`, `ml-IN`, `mr-IN`, `od-IN`, `pa-IN`, `ta-IN`, `te-IN`), shown only when `ttsProvider === "sarvam"` — no other provider currently reads this field.

## Changes

1. `drizzle/platformSchema.ts` — new `ttsLanguage` column.
2. `shared/types.ts` — `ttsLanguage: string | null`.
3. `server/agentRouter.ts` — accept `ttsLanguage` in create/update input schemas.
4. `shared/providerOptions.ts` — new `TTS_LANGUAGES` export (Sarvam's 11 codes with human-readable labels), `en-IN` first/default.
5. `client/src/components/agents/LiveKitSection.tsx` — Language dropdown, rendered only for `ttsProvider === "sarvam"`.
6. `server/services/agentDeployer.ts` — pass `TTS_LANGUAGE` into the agent's ConfigMap.
7. `agent-template/src/config.py` — `tts_language: str = "en-IN"`.
8. `agent-template/src/agent/plugins.py` — `sarvam.TTS(target_language_code=settings.tts_language or "en-IN", ...)`.

## Out of scope

- Per-utterance auto language detection (code-mixed Hinglish within a single response) — the plugin has no such capability; this fix is a per-agent static setting, matching how `ttsVoice` already works.
- Language selection for any TTS provider other than sarvam.

## Immediate remediation

Set `ttsLanguage="hi-IN"` on `agent-fedfina` (guruji app) once shipped, redeploy, and verify live.
