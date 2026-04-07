import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Plus, Bot } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useAppContext } from "@/contexts/AppContext";
import { cn, slugify } from "@/lib/utils";

export default function AgentListPanel() {
  const {
    selectedAppId, setSelectedAppId,
    selectedAppSlug, setSelectedAppSlug,
    selectedAgentId, setSelectedAgentId,
  } = useAppContext();

  const { data: apps } = trpc.appsCrud.list.useQuery();
  const { data: agents, refetch: refetchAgents } = trpc.agentsCrud.list.useQuery(
    { appId: selectedAppId || 0 },
    { enabled: !!selectedAppId },
  );

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");

  const createMutation = trpc.agentsCrud.create.useMutation({
    onSuccess: (agent) => {
      toast.success(`Agent "${agent.name}" created`);
      setShowCreate(false);
      setNewName("");
      setNewDesc("");
      refetchAgents();
      setSelectedAgentId(agent.id);
    },
    onError: (err) => toast.error(err.message),
  });

  const provisionedApps = apps?.filter((a) => a.provisioningStatus === "completed") || [];

  return (
    <div className="w-72 flex-shrink-0 flex flex-col border rounded-lg bg-card">
      {/* App selector */}
      <div className="p-3 border-b">
        <Label className="text-xs text-muted-foreground mb-1 block">App</Label>
        <Select
          value={selectedAppId?.toString() || ""}
          onValueChange={(val) => {
            const app = provisionedApps.find((a) => a.id.toString() === val);
            setSelectedAppId(app?.id || null);
            setSelectedAppSlug(app?.slug || null);
            setSelectedAgentId(null);
          }}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select an app" />
          </SelectTrigger>
          <SelectContent>
            {provisionedApps.map((app) => (
              <SelectItem key={app.id} value={app.id.toString()}>
                {app.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Agent list */}
      <div className="flex-1 overflow-auto p-2 space-y-1">
        {!selectedAppId ? (
          <p className="text-xs text-muted-foreground text-center py-4">Select an app first</p>
        ) : !agents || agents.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4">No agents yet</p>
        ) : (
          agents.map((agent) => (
            <button
              key={agent.id}
              className={cn(
                "w-full flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors",
                selectedAgentId === agent.id
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-muted/50 text-muted-foreground",
              )}
              onClick={() => setSelectedAgentId(agent.id)}
            >
              <Bot className="h-4 w-4 flex-shrink-0" />
              <span className="flex-1 truncate">{agent.name}</span>
              <Badge
                variant="secondary"
                className={cn("text-[10px] px-1.5", agent.deployed && "bg-green-500/20 text-green-400")}
              >
                {agent.deploymentStatus || (agent.deployed ? "live" : "draft")}
              </Badge>
            </button>
          ))
        )}
      </div>

      {/* Add agent button */}
      <div className="p-3 border-t">
        <Button
          className="w-full"
          size="sm"
          disabled={!selectedAppId}
          onClick={() => setShowCreate(true)}
        >
          <Plus className="h-4 w-4 mr-1" /> Add Agent
        </Button>
      </div>

      {/* Create dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Agent</DialogTitle>
            <DialogDescription>Create a new agent under {selectedAppSlug}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Agent Name</Label>
              <Input
                value={newName}
                onChange={(e) => setNewName(slugify(e.target.value))}
                placeholder="my-agent"
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground mt-1">Lowercase with hyphens only</p>
            </div>
            <div>
              <Label>Description (optional)</Label>
              <Input value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder="What does this agent do?" />
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
              <Button
                onClick={() => createMutation.mutate({
                  appId: selectedAppId!,
                  name: newName,
                  description: newDesc || undefined,
                })}
                disabled={!newName || createMutation.isPending}
              >
                {createMutation.isPending ? "Creating..." : "Create"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
