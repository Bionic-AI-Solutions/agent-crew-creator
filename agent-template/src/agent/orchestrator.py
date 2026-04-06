"""Orchestrator: routes crew execution to Dify workflow engine."""

import json
import logging
import httpx
from config import settings

logger = logging.getLogger("orchestrator")


class CrewConfig:
    """Configuration for a single crew from the registry."""

    def __init__(self, data: dict):
        self.name: str = data.get("name", "")
        self.dify_app_id: str = data.get("difyAppId", "")
        self.dify_app_api_key: str = data.get("difyAppApiKey", "")
        self.mode: str = data.get("mode", "workflow")


class Orchestrator:
    """Manages crew selection and execution via Dify workflows."""

    def __init__(self):
        self.enabled_crews: list[str] = (
            json.loads(settings.enabled_crews) if settings.enabled_crews else []
        )
        self.crew_registry: dict[str, CrewConfig] = {}
        self._load_registry()

    def _load_registry(self):
        """Load crew registry from config (injected via ConfigMap)."""
        try:
            registry = json.loads(settings.crew_registry) if settings.crew_registry else []
            for entry in registry:
                config = CrewConfig(entry)
                if config.name:
                    self.crew_registry[config.name] = config
            logger.info(f"Loaded {len(self.crew_registry)} crews from registry")
        except Exception as e:
            logger.error(f"Failed to load crew registry: {e}")

    async def execute_crew(self, crew_name: str, context: dict, user_id: str) -> dict:
        """Execute a crew by dispatching to its Dify workflow.

        Args:
            crew_name: Name of the crew to execute.
            context: Task context including 'task' description and any additional data.
            user_id: Identifier for the requesting user/agent.

        Returns:
            Dict with 'summary', 'artifacts', 'crew', 'status', and optional error info.
        """
        if crew_name not in self.enabled_crews:
            return {
                "summary": f"Crew '{crew_name}' is not enabled for this agent",
                "artifacts": [],
                "crew": crew_name,
                "status": "error",
            }

        crew_config = self.crew_registry.get(crew_name)
        if not crew_config or not crew_config.dify_app_api_key:
            return {
                "summary": f"Crew '{crew_name}' is not configured (missing Dify API key)",
                "artifacts": [],
                "crew": crew_name,
                "status": "error",
            }

        if not settings.dify_base_url:
            return {
                "summary": "Dify crew engine not configured (DIFY_BASE_URL not set)",
                "artifacts": [],
                "crew": crew_name,
                "status": "error",
            }

        logger.info(f"Executing crew '{crew_name}' via Dify (mode={crew_config.mode})")

        try:
            result = await self._call_dify_workflow(crew_config, context, user_id)
            return {
                "summary": self._extract_summary(result),
                "artifacts": self._extract_artifacts(result),
                "crew": crew_name,
                "status": "completed",
                "dify_run_id": result.get("workflow_run_id", ""),
                "elapsed_time": result.get("elapsed_time"),
                "total_tokens": result.get("total_tokens"),
            }
        except Exception as e:
            logger.error(f"Crew '{crew_name}' execution failed: {e}")
            return {
                "summary": f"Crew '{crew_name}' failed: {str(e)}",
                "artifacts": [],
                "crew": crew_name,
                "status": "failed",
                "error": str(e),
            }

    async def _call_dify_workflow(
        self, crew: CrewConfig, context: dict, user_id: str
    ) -> dict:
        """Call Dify workflow API in blocking mode."""
        url = f"{settings.dify_base_url}/v1/workflows/run"

        payload = {
            "inputs": {
                "task": context.get("task", ""),
                "context": json.dumps(context.get("context", {})),
                **{k: v for k, v in context.items() if k not in ("task", "context")},
            },
            "response_mode": "blocking",
            "user": user_id,
        }

        async with httpx.AsyncClient(timeout=300.0) as client:
            response = await client.post(
                url,
                json=payload,
                headers={
                    "Authorization": f"Bearer {crew.dify_app_api_key}",
                    "Content-Type": "application/json",
                },
            )
            response.raise_for_status()
            data = response.json()

        # Extract from Dify's response format
        return {
            "workflow_run_id": data.get("workflow_run_id", ""),
            "task_id": data.get("task_id", ""),
            "status": data.get("data", {}).get("status", "succeeded"),
            "outputs": data.get("data", {}).get("outputs", {}),
            "elapsed_time": data.get("data", {}).get("elapsed_time"),
            "total_tokens": data.get("data", {}).get("total_tokens"),
            "error": data.get("data", {}).get("error"),
        }

    def _extract_summary(self, result: dict) -> str:
        """Extract a human-readable summary from Dify workflow outputs."""
        outputs = result.get("outputs", {})
        # Common Dify output field names
        for key in ("summary", "result", "output", "response", "answer", "text"):
            if key in outputs and isinstance(outputs[key], str):
                return outputs[key]
        # Fall back to JSON string of all outputs
        if outputs:
            return json.dumps(outputs, indent=2, default=str)[:2000]
        return f"Workflow completed (run_id={result.get('workflow_run_id', 'unknown')})"

    def _extract_artifacts(self, result: dict) -> list[dict]:
        """Extract artifacts (files, images, etc.) from Dify workflow outputs."""
        outputs = result.get("outputs", {})
        artifacts = []
        for key in ("artifacts", "files", "images", "documents"):
            if key in outputs:
                val = outputs[key]
                if isinstance(val, list):
                    artifacts.extend(val)
                elif isinstance(val, dict):
                    artifacts.append(val)
        return artifacts

    async def list_available_crews(self) -> list[dict]:
        """Return metadata about enabled crews."""
        result = []
        for name in self.enabled_crews:
            config = self.crew_registry.get(name)
            result.append({
                "name": name,
                "configured": config is not None and bool(config.dify_app_api_key),
                "mode": config.mode if config else "unknown",
            })
        return result
