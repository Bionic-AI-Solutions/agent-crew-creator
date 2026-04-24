export interface SanitizedApp {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  livekitUrl: string;
  apiKeyPrefix: string;
  roomPrefix: string | null;
  enabledServices: string[];
  provisioningStatus: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentConfigSummary {
  id: number;
  appId: number;
  name: string;
  description: string | null;
  deployed: boolean;
  deploymentStatus: string | null;
  createdAt: string;
}

export interface AgentConfigFull {
  id: number;
  appId: number;
  name: string;
  description: string | null;

  // LiveKit
  sttProvider: string;
  sttModel: string | null;
  llmProvider: string;
  llmModel: string | null;
  ttsProvider: string;
  ttsVoice: string | null;
  systemPrompt: string | null;
  avatarEnabled: boolean;
  avatarProvider: string | null;
  avatarReferenceImage: string | null;
  avatarName: string | null;
  captureMode: string;
  captureInterval: number | null;

  // Letta
  lettaAgentName: string | null;
  lettaAgentId: string | null;
  lettaLlmModel: string | null;
  lettaSystemPrompt: string | null;

  // Deployment
  deployed: boolean;
  imageTag: string | null;
  deploymentStatus: string | null;
  lastDeployedAt: string | null;

  // Relations
  tools: { toolId: string; enabled: boolean }[];
  mcpServers: { mcpServerId: number; enabled: boolean; name: string; url: string }[];
  crews: { crewName: string; enabled: boolean }[];
  documents: {
    id: number;
    filename: string;
    fileSizeBytes: number | null;
    processingStatus: string;
    createdAt: string;
  }[];

  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}
