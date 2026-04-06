import { relations } from "drizzle-orm";
import {
  apps,
  provisioningJobs,
  agentConfigs,
  agentTools,
  customTools,
  mcpServers,
  agentMcpServers,
  agentCrews,
  agentDocuments,
  crews,
  crewExecutions,
} from "./platformSchema";

export const appsRelations = relations(apps, ({ many }) => ({
  provisioningJobs: many(provisioningJobs),
  agentConfigs: many(agentConfigs),
  customTools: many(customTools),
  mcpServers: many(mcpServers),
  crews: many(crews),
}));

export const provisioningJobsRelations = relations(provisioningJobs, ({ one }) => ({
  app: one(apps, { fields: [provisioningJobs.appId], references: [apps.id] }),
}));

export const agentConfigsRelations = relations(agentConfigs, ({ one, many }) => ({
  app: one(apps, { fields: [agentConfigs.appId], references: [apps.id] }),
  tools: many(agentTools),
  mcpServers: many(agentMcpServers),
  crews: many(agentCrews),
  documents: many(agentDocuments),
}));

export const agentToolsRelations = relations(agentTools, ({ one }) => ({
  agentConfig: one(agentConfigs, { fields: [agentTools.agentConfigId], references: [agentConfigs.id] }),
}));

export const customToolsRelations = relations(customTools, ({ one }) => ({
  app: one(apps, { fields: [customTools.appId], references: [apps.id] }),
}));

export const mcpServersRelations = relations(mcpServers, ({ one, many }) => ({
  app: one(apps, { fields: [mcpServers.appId], references: [apps.id] }),
  agentLinks: many(agentMcpServers),
}));

export const agentMcpServersRelations = relations(agentMcpServers, ({ one }) => ({
  agentConfig: one(agentConfigs, { fields: [agentMcpServers.agentConfigId], references: [agentConfigs.id] }),
  mcpServer: one(mcpServers, { fields: [agentMcpServers.mcpServerId], references: [mcpServers.id] }),
}));

export const agentCrewsRelations = relations(agentCrews, ({ one }) => ({
  agentConfig: one(agentConfigs, { fields: [agentCrews.agentConfigId], references: [agentConfigs.id] }),
}));

export const agentDocumentsRelations = relations(agentDocuments, ({ one }) => ({
  agentConfig: one(agentConfigs, { fields: [agentDocuments.agentConfigId], references: [agentConfigs.id] }),
}));

export const crewsRelations = relations(crews, ({ one, many }) => ({
  app: one(apps, { fields: [crews.appId], references: [apps.id] }),
  executions: many(crewExecutions),
}));

export const crewExecutionsRelations = relations(crewExecutions, ({ one }) => ({
  crew: one(crews, { fields: [crewExecutions.crewId], references: [crews.id] }),
  agentConfig: one(agentConfigs, { fields: [crewExecutions.agentConfigId], references: [agentConfigs.id] }),
}));
