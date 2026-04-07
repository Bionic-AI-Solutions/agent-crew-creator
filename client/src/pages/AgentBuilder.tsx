import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useAppContext } from "@/contexts/AppContext";
import AgentListPanel from "@/components/agents/AgentListPanel";
import AgentConfigForm from "@/components/agents/AgentConfigForm";

export default function AgentBuilder() {
  const { selectedAppId, selectedAppSlug, selectedAgentId, setSelectedAgentId } = useAppContext();
  const { data: apps } = trpc.appsCrud.list.useQuery();

  // If no apps exist, show empty state
  if (!apps || apps.length === 0) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold">Agent Builder</h1>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <p className="text-muted-foreground mb-4">Create an App first before building agents.</p>
            <Button onClick={() => window.location.href = "/apps"}>
              <Plus className="h-4 w-4 mr-1" /> Create App
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-bold">Agent Builder</h1>

      <div className="flex gap-6 h-[calc(100vh-10rem)]">
        {/* Left Panel */}
        <AgentListPanel />

        {/* Right Panel */}
        <div className="flex-1 overflow-auto">
          {selectedAgentId ? (
            <AgentConfigForm agentId={selectedAgentId} />
          ) : (
            <Card>
              <CardContent className="flex items-center justify-center py-20 text-muted-foreground">
                {selectedAppId
                  ? "Select an agent from the list or create a new one"
                  : "Select an app to get started"}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
