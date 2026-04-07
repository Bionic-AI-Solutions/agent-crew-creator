export interface BuiltinTool {
  id: string;
  name: string;
  description: string;
  source: "builtin";
}

export interface CustomToolDef {
  id: number;
  appId: number;
  name: string;
  description: string | null;
  toolType: string;
  source: "custom";
}

export type AvailableTool = BuiltinTool | CustomToolDef;

export interface McpServerInfo {
  id: number;
  appId: number;
  name: string;
  url: string;
  transport: string;
  authType: string;
  description: string | null;
}

export interface McpTestResult {
  connected: boolean;
  tools: { name: string; description: string }[];
  error?: string;
}
