export interface BuiltinToolDef {
  id: string;
  name: string;
  description: string;
  /**
   * If set, this is a tool registered in the Letta server. When attached to
   * an agent via setAgentTools, the server will also call Letta's
   * PATCH /v1/agents/:id API to include this tool in the Letta agent's
   * attached tools. Resolved by name at runtime so Letta tool IDs can change
   * without redeploying the platform.
   */
  lettaToolName?: string;
}

/**
 * Tools available for agents. Only tools with actual Letta-side implementations
 * are listed here. Letta's built-in tools (conversation_search, memory_insert,
 * memory_replace, archival_memory_search) are always attached by default and
 * don't need entries here.
 *
 * Removed duplicates of Letta native capabilities:
 * - recall_memory → Letta's conversation_search
 * - remember → Letta's memory_insert/memory_replace
 * - search_documents → Letta's archival_memory_search (uploaded docs become passages)
 * - upload_document → platform UI action, not an agent tool
 * - show_artifact → frontend rendering, not a tool
 */
export const BUILTIN_TOOLS: BuiltinToolDef[] = [
  { id: "run_crew", name: "Run Crew", description: "Run a specialized agent crew (Dify workflow) for complex multi-step tasks", lettaToolName: "run_crew" },
  { id: "web_search", name: "Web Search", description: "Search the web for real-time information using the search MCP", lettaToolName: "web_search" },
  {
    id: "generate_image",
    name: "Generate Image",
    description: "Generate an educational image, store in MinIO, return presigned URL for chat panel",
    lettaToolName: "generate_image",
  },
  {
    id: "code_interpreter",
    name: "Code Interpreter",
    description: "Execute Python code in a sandboxed environment for computation, data analysis, and visualization",
    lettaToolName: "code_interpreter",
  },
  {
    id: "generate_pdf",
    name: "Generate PDF",
    description: "Generate a formatted PDF document from structured content, store in MinIO, return download URL",
    lettaToolName: "generate_pdf",
  },
  {
    id: "generate_persona_image",
    name: "Generate Persona Image",
    description: "Generate a photorealistic avatar image from persona parameters (profession, appearance, environment) and set it as the agent's BitHuman avatar",
    lettaToolName: "generate_persona_image",
  },
];
