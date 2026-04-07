export interface BuiltinToolDef {
  id: string;
  name: string;
  description: string;
}

export const BUILTIN_TOOLS: BuiltinToolDef[] = [
  { id: "recall_memory", name: "Recall Memory", description: "Search memory across session, user, and app knowledge" },
  { id: "remember", name: "Remember", description: "Store a preference or fact in long-term memory" },
  { id: "run_crew", name: "Run Crew", description: "Run a specialized agent crew for a complex task" },
  { id: "search_documents", name: "Search Documents", description: "Search uploaded documents and knowledge base" },
  { id: "show_artifact", name: "Show Artifact", description: "Display an artifact (chart, report, image) in the UI" },
  { id: "upload_document", name: "Upload Document", description: "Process and index a shared document" },
  { id: "web_search", name: "Web Search", description: "Search the web for real-time information" },
  { id: "code_interpreter", name: "Code Interpreter", description: "Execute Python code for computation and analysis" },
];
