import {
  boolean,
  index,
  integer,
  json,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

// ── Apps (tenants) ──────────────────────────────────────────────

export const apps = pgTable("apps", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  slug: varchar("slug", { length: 100 }).notNull().unique(),
  description: text("description"),
  livekitUrl: varchar("livekit_url", { length: 500 }).notNull(),
  apiKey: varchar("api_key", { length: 255 }).notNull().default(""),
  apiSecret: varchar("api_secret", { length: 500 }).notNull().default(""),
  roomPrefix: varchar("room_prefix", { length: 100 }),
  enabledServices: json("enabled_services").$type<string[]>().default(["livekit"]).notNull(),
  provisioningStatus: varchar("provisioning_status", { length: 50 }).default("pending").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ── App Members (per-app RBAC) ──────────────────────────────────

export const appMembers = pgTable(
  "app_members",
  {
    id: serial("id").primaryKey(),
    appId: integer("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    // Keycloak `sub` claim — matches SessionUser.sub
    userId: varchar("user_id", { length: 255 }).notNull(),
    role: varchar("role", { length: 20 }).default("member").notNull(), // owner | member
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_app_members_unique").on(table.appId, table.userId),
    index("idx_app_members_user").on(table.userId),
  ],
);

export type AppMember = typeof appMembers.$inferSelect;

// ── Provisioning Jobs ───────────────────────────────────────────

export const provisioningJobs = pgTable(
  "provisioning_jobs",
  {
    id: serial("id").primaryKey(),
    appId: integer("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    jobType: varchar("job_type", { length: 50 }).notNull(),
    status: varchar("status", { length: 50 }).default("pending").notNull(),
    currentStep: varchar("current_step", { length: 100 }),
    steps: json("steps").$type<ProvisioningStepRecord[]>().notNull(),
    error: text("error"),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [index("idx_prov_jobs_app_id").on(table.appId)],
);

// ── Agent Configs ───────────────────────────────────────────────

export const agentConfigs = pgTable(
  "agent_configs",
  {
    id: serial("id").primaryKey(),
    appId: integer("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(),
    description: text("description"),

    // LiveKit voice pipeline
    sttProvider: varchar("stt_provider", { length: 50 }).default("gpu-ai").notNull(),
    sttModel: varchar("stt_model", { length: 100 }),
    // PRIMARY voice LLM (fast, low-latency). The Letta brain is secondary
    // and accessed via tools (run_crew, recall_memory) — its model lives
    // in lettaLlmModel below. Default to gpu-ai gemma for sub-second turns.
    llmProvider: varchar("llm_provider", { length: 50 }).default("gpu-ai").notNull(),
    llmModel: varchar("llm_model", { length: 200 }).default("gemma-4-e4b-it"),
    ttsProvider: varchar("tts_provider", { length: 50 }).default("gpu-ai").notNull(),
    ttsVoice: varchar("tts_voice", { length: 200 }).default("Sudhir-IndexTTS2"),
    systemPrompt: text("system_prompt"),
    visionEnabled: boolean("vision_enabled").default(false).notNull(),
    avatarEnabled: boolean("avatar_enabled").default(false).notNull(),
    backgroundAudioEnabled: boolean("background_audio_enabled").default(false).notNull(),
    captureMode: varchar("capture_mode", { length: 20 }).default("off").notNull(),
    captureInterval: integer("capture_interval").default(5),

    // Letta agent (secondary/execution arm)
    lettaAgentName: varchar("letta_agent_name", { length: 255 }),
    lettaAgentId: varchar("letta_agent_id", { length: 255 }),
    lettaLlmModel: varchar("letta_llm_model", { length: 200 }).default("openai-proxy/qwen3.5-27b-fp8"),
    lettaSystemPrompt: text("letta_system_prompt"),

    // Deployment
    deployed: boolean("deployed").default(false).notNull(),
    imageTag: varchar("image_tag", { length: 100 }).default("latest"),
    deploymentStatus: varchar("deployment_status", { length: 50 }),
    lastDeployedAt: timestamp("last_deployed_at"),

    metadata: json("metadata"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_agent_configs_app_name").on(table.appId, table.name),
    index("idx_agent_configs_app_id").on(table.appId),
  ],
);

// ── Agent Tools (many-to-many) ──────────────────────────────────

export const agentTools = pgTable(
  "agent_tools",
  {
    id: serial("id").primaryKey(),
    agentConfigId: integer("agent_config_id")
      .notNull()
      .references(() => agentConfigs.id, { onDelete: "cascade" }),
    toolId: varchar("tool_id", { length: 100 }).notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    config: json("config"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_agent_tools_unique").on(table.agentConfigId, table.toolId),
  ],
);

// ── Custom Tools ────────────────────────────────────────────────

export const customTools = pgTable(
  "custom_tools",
  {
    id: serial("id").primaryKey(),
    appId: integer("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(),
    description: text("description"),
    toolType: varchar("tool_type", { length: 50 }).notNull(),
    definition: json("definition").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_custom_tools_app_name").on(table.appId, table.name),
  ],
);

// ── MCP Servers ─────────────────────────────────────────────────

export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: serial("id").primaryKey(),
    appId: integer("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(),
    url: varchar("url", { length: 500 }).notNull(),
    transport: varchar("transport", { length: 20 }).default("streamable-http").notNull(),
    authType: varchar("auth_type", { length: 20 }).default("none").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_mcp_servers_app_name").on(table.appId, table.name),
  ],
);

// ── Agent ↔ MCP Servers (many-to-many) ──────────────────────────

export const agentMcpServers = pgTable(
  "agent_mcp_servers",
  {
    id: serial("id").primaryKey(),
    agentConfigId: integer("agent_config_id")
      .notNull()
      .references(() => agentConfigs.id, { onDelete: "cascade" }),
    mcpServerId: integer("mcp_server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").default(true).notNull(),
  },
  (table) => [
    uniqueIndex("idx_agent_mcp_unique").on(table.agentConfigId, table.mcpServerId),
  ],
);

// ── Agent Crews ─────────────────────────────────────────────────

export const agentCrews = pgTable(
  "agent_crews",
  {
    id: serial("id").primaryKey(),
    agentConfigId: integer("agent_config_id")
      .notNull()
      .references(() => agentConfigs.id, { onDelete: "cascade" }),
    crewName: varchar("crew_name", { length: 100 }).notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    config: json("config"),
  },
  (table) => [
    uniqueIndex("idx_agent_crews_unique").on(table.agentConfigId, table.crewName),
  ],
);

// ── Crews (Dify workflows registered per app) ──────────────────

export const crews = pgTable(
  "crews",
  {
    id: serial("id").primaryKey(),
    appId: integer("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(),
    description: text("description"),
    difyAppId: varchar("dify_app_id", { length: 255 }),
    difyWorkflowId: varchar("dify_workflow_id", { length: 255 }),
    difyAppApiKey: varchar("dify_app_api_key", { length: 500 }),
    mode: varchar("mode", { length: 50 }).default("workflow").notNull(),
    isTemplate: boolean("is_template").default(false).notNull(),
    config: json("config"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_crews_app_name").on(table.appId, table.name),
    index("idx_crews_app_id").on(table.appId),
  ],
);

// ── Crew Executions (task run history) ─────────────────────────

export const crewExecutions = pgTable(
  "crew_executions",
  {
    id: serial("id").primaryKey(),
    crewId: integer("crew_id")
      .notNull()
      .references(() => crews.id, { onDelete: "cascade" }),
    agentConfigId: integer("agent_config_id")
      .references(() => agentConfigs.id, { onDelete: "set null" }),
    difyRunId: varchar("dify_run_id", { length: 255 }),
    taskPayload: json("task_payload"),
    status: varchar("status", { length: 50 }).default("pending").notNull(),
    result: json("result"),
    error: text("error"),
    elapsedTimeMs: integer("elapsed_time_ms"),
    totalTokens: integer("total_tokens"),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  (table) => [
    index("idx_crew_executions_crew").on(table.crewId),
    index("idx_crew_executions_agent").on(table.agentConfigId),
    index("idx_crew_executions_status").on(table.status),
  ],
);

// ── Agent Documents (RAG) ───────────────────────────────────────

export const agentDocuments = pgTable(
  "agent_documents",
  {
    id: serial("id").primaryKey(),
    agentConfigId: integer("agent_config_id")
      .notNull()
      .references(() => agentConfigs.id, { onDelete: "cascade" }),
    filename: varchar("filename", { length: 500 }).notNull(),
    minioKey: varchar("minio_key", { length: 1000 }).notNull(),
    fileSizeBytes: integer("file_size_bytes"),
    contentType: varchar("content_type", { length: 100 }),
    chunkCount: integer("chunk_count"),
    lettaPassageIds: json("letta_passage_ids").$type<string[]>(),
    processingStatus: varchar("processing_status", { length: 50 }).default("pending").notNull(),
    error: text("error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_agent_docs_config").on(table.agentConfigId),
  ],
);

// ── Embed Tokens (per-agent embeddable widget keys) ────────────

export const embedTokens = pgTable(
  "embed_tokens",
  {
    id: serial("id").primaryKey(),
    agentConfigId: integer("agent_config_id")
      .notNull()
      .references(() => agentConfigs.id, { onDelete: "cascade" }),
    appId: integer("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    token: varchar("token", { length: 64 }).notNull().unique(),
    label: varchar("label", { length: 100 }).default("default").notNull(),
    // Feature toggles
    allowVoice: boolean("allow_voice").default(true).notNull(),
    allowChat: boolean("allow_chat").default(true).notNull(),
    allowVideo: boolean("allow_video").default(false).notNull(),
    allowScreenShare: boolean("allow_screen_share").default(false).notNull(),
    allowAvatar: boolean("allow_avatar").default(false).notNull(),
    showTranscription: boolean("show_transcription").default(true).notNull(),
    // Appearance
    theme: varchar("theme", { length: 20 }).default("light").notNull(),
    mode: varchar("mode", { length: 20 }).default("popup").notNull(), // popup | iframe
    // Security
    allowedOrigins: json("allowed_origins").$type<string[]>().default([]),
    isActive: boolean("is_active").default(true).notNull(),
    lastUsedAt: timestamp("last_used_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_embed_tokens_agent").on(table.agentConfigId),
    index("idx_embed_tokens_token").on(table.token),
  ],
);

// ── Type helpers ────────────────────────────────────────────────

// ── User Memory Blocks (per-user Letta memory isolation) ────────

export const userMemoryBlocks = pgTable(
  "user_memory_blocks",
  {
    id: serial("id").primaryKey(),
    appId: integer("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    agentConfigId: integer("agent_config_id")
      .notNull()
      .references(() => agentConfigs.id, { onDelete: "cascade" }),
    userId: varchar("user_id", { length: 255 }).notNull(),
    blockLabel: varchar("block_label", { length: 100 }).default("human").notNull(),
    lettaBlockId: varchar("letta_block_id", { length: 255 }).notNull(),
    lastSessionAt: timestamp("last_session_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_user_memory_unique").on(table.agentConfigId, table.userId, table.blockLabel),
    index("idx_user_memory_app").on(table.appId),
    index("idx_user_memory_user").on(table.userId),
  ],
);

export interface ProvisioningStepRecord {
  name: string;
  label: string;
  status: "pending" | "running" | "success" | "failed" | "skipped";
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export type App = typeof apps.$inferSelect;
export type InsertApp = typeof apps.$inferInsert;
export type AgentConfig = typeof agentConfigs.$inferSelect;
export type InsertAgentConfig = typeof agentConfigs.$inferInsert;
export type CustomTool = typeof customTools.$inferSelect;
export type McpServer = typeof mcpServers.$inferSelect;
export type AgentDocument = typeof agentDocuments.$inferSelect;
export type ProvisioningJob = typeof provisioningJobs.$inferSelect;
export type Crew = typeof crews.$inferSelect;
export type InsertCrew = typeof crews.$inferInsert;
export type CrewExecution = typeof crewExecutions.$inferSelect;
export type UserMemoryBlock = typeof userMemoryBlocks.$inferSelect;
export type EmbedToken = typeof embedTokens.$inferSelect;
export type InsertEmbedToken = typeof embedTokens.$inferInsert;
