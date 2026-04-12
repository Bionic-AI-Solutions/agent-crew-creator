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

export const BUILTIN_TOOLS: BuiltinToolDef[] = [
  { id: "recall_memory", name: "Recall Memory", description: "Search memory across session, user, and app knowledge" },
  { id: "remember", name: "Remember", description: "Store a preference or fact in long-term memory" },
  { id: "run_crew", name: "Run Crew", description: "Run a specialized agent crew for a complex task", lettaToolName: "run_crew" },
  { id: "search_documents", name: "Search Documents", description: "Search uploaded documents and knowledge base" },
  { id: "show_artifact", name: "Show Artifact", description: "Display an artifact (chart, report, image) in the UI" },
  { id: "upload_document", name: "Upload Document", description: "Process and index a shared document" },
  { id: "web_search", name: "Web Search", description: "Search the web for real-time information" },
  { id: "code_interpreter", name: "Code Interpreter", description: "Execute Python code for computation and analysis" },
  {
    id: "generate_image",
    name: "Generate Image (Nano Banana)",
    description:
      "Generate an educational image using Gemini 2.5 Flash Image (Nano Banana), store permanently in MinIO, and return a 24h presigned URL for the chat panel. Auto-inserts an archival memory entry.",
    lettaToolName: "generate_image",
  },
];
