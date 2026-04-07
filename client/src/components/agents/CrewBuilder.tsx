import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Users,
  Plus,
  ExternalLink,
  Play,
  Trash2,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";

interface Props {
  agentId: number;
  appId: number;
}

export default function CrewBuilder({ agentId, appId }: Props) {
  const utils = trpc.useUtils();
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newCrewName, setNewCrewName] = useState("");
  const [newCrewDescription, setNewCrewDescription] = useState("");
  const [newCrewMode, setNewCrewMode] = useState("workflow");
  const [newCrewDifyApiKey, setNewCrewDifyApiKey] = useState("");

  // Queries
  const { data: crews, isLoading: crewsLoading } = trpc.agentsCrud.listCrews.useQuery({ appId });
  const { data: agent } = trpc.agentsCrud.getById.useQuery({ id: agentId });
  const { data: templates } = trpc.agentsCrud.listCrewTemplates.useQuery();
  const { data: difyEmbed } = trpc.agentsCrud.getDifyEmbedUrl.useQuery({ appId });
  const { data: executions } = trpc.agentsCrud.listCrewExecutions.useQuery({ agentConfigId: agentId, limit: 10 });

  // Mutations
  const createCrewMutation = trpc.agentsCrud.createCrew.useMutation({
    onSuccess: () => {
      toast.success("Crew created");
      setShowCreateDialog(false);
      setNewCrewName("");
      setNewCrewDescription("");
      setNewCrewDifyApiKey("");
      utils.agentsCrud.listCrews.invalidate({ appId });
    },
    onError: (err) => toast.error(err.message),
  });

  const deleteCrewMutation = trpc.agentsCrud.deleteCrew.useMutation({
    onSuccess: () => {
      toast.success("Crew deleted");
      utils.agentsCrud.listCrews.invalidate({ appId });
    },
  });

  const setCrewsMutation = trpc.agentsCrud.setAgentCrews.useMutation({
    onSuccess: () => {
      toast.success("Agent crews updated");
      utils.agentsCrud.getById.invalidate({ id: agentId });
    },
  });

  const selectedCrews = agent?.crews?.map((c) => c.crewName) || [];

  const toggleCrew = (crewName: string) => {
    const newCrews = selectedCrews.includes(crewName)
      ? selectedCrews.filter((c) => c !== crewName)
      : [...selectedCrews, crewName];
    setCrewsMutation.mutate({ agentConfigId: agentId, crewNames: newCrews });
  };

  const handleCreateCrew = () => {
    if (!newCrewName) return;
    createCrewMutation.mutate({
      appId,
      name: newCrewName.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, ""),
      description: newCrewDescription || undefined,
      mode: newCrewMode as "workflow" | "agent-chat" | "completion",
      difyAppApiKey: newCrewDifyApiKey || undefined,
    });
  };

  const statusIcon = (status: string) => {
    switch (status) {
      case "succeeded":
      case "completed":
        return <CheckCircle2 className="h-3 w-3 text-green-500" />;
      case "failed":
        return <XCircle className="h-3 w-3 text-red-500" />;
      case "running":
      case "pending":
        return <Loader2 className="h-3 w-3 text-blue-500 animate-spin" />;
      default:
        return <Clock className="h-3 w-3 text-muted-foreground" />;
    }
  };

  return (
    <div className="space-y-4">
      {/* Crew Management */}
      <Card>
        <CardHeader className="pb-3 flex flex-row items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Users className="h-4 w-4" /> Crews (Dify Workflows)
          </CardTitle>
          <div className="flex gap-2">
            {difyEmbed?.externalUrl && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => window.open("/dify-login", "_blank")}
              >
                <ExternalLink className="h-3 w-3 mr-1" /> Open Dify Editor
              </Button>
            )}
            <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
              <DialogTrigger asChild>
                <Button size="sm" variant="outline">
                  <Plus className="h-3 w-3 mr-1" /> New Crew
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Create New Crew</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                  <div>
                    <label className="text-sm font-medium">Name</label>
                    <Input
                      placeholder="deep_research"
                      value={newCrewName}
                      onChange={(e) => setNewCrewName(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      Lowercase, underscores only (e.g., deep_research)
                    </p>
                  </div>
                  <div>
                    <label className="text-sm font-medium">Description</label>
                    <Textarea
                      placeholder="What does this crew do?"
                      value={newCrewDescription}
                      onChange={(e) => setNewCrewDescription(e.target.value)}
                      rows={2}
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium">Workflow Mode</label>
                    <Select value={newCrewMode} onValueChange={setNewCrewMode}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="workflow">Workflow (Sequential/Parallel)</SelectItem>
                        <SelectItem value="agent-chat">Agent Chat (ReAct / Self-healing)</SelectItem>
                        <SelectItem value="completion">Completion (Single-step)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label className="text-sm font-medium">Dify App API Key</label>
                    <Input
                      placeholder="app-xxxxxxxx"
                      value={newCrewDifyApiKey}
                      onChange={(e) => setNewCrewDifyApiKey(e.target.value)}
                      type="password"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      Create the workflow in Dify first, then paste its API key here
                    </p>
                  </div>
                  <Button onClick={handleCreateCrew} disabled={createCrewMutation.isPending || !newCrewName}>
                    {createCrewMutation.isPending ? "Creating..." : "Create Crew"}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </CardHeader>
        <CardContent>
          {crewsLoading ? (
            <p className="text-xs text-muted-foreground">Loading crews...</p>
          ) : !crews || crews.length === 0 ? (
            <div className="text-center py-6">
              <p className="text-sm text-muted-foreground mb-2">No crews created yet</p>
              <p className="text-xs text-muted-foreground">
                Create a workflow in Dify, then register it as a crew here
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {crews.map((crew) => (
                <div key={crew.id} className="flex items-start gap-2 p-2 rounded border">
                  <Checkbox
                    checked={selectedCrews.includes(crew.name)}
                    onCheckedChange={() => toggleCrew(crew.name)}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{crew.name}</span>
                      <Badge variant="outline" className="text-xs">
                        {crew.mode}
                      </Badge>
                      {crew.difyAppApiKey ? (
                        <Badge variant="default" className="text-xs bg-green-600">configured</Badge>
                      ) : (
                        <Badge variant="secondary" className="text-xs">no API key</Badge>
                      )}
                    </div>
                    {crew.description && (
                      <p className="text-xs text-muted-foreground">{crew.description}</p>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-red-500 h-6 w-6 p-0"
                    onClick={() => {
                      if (confirm(`Delete crew "${crew.name}"?`)) {
                        deleteCrewMutation.mutate({ id: crew.id });
                      }
                    }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Crew Templates */}
      {templates && templates.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Crew Templates</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {templates.map((tpl) => (
                <div key={tpl.name} className="p-2 rounded border text-xs">
                  <div className="font-medium">{tpl.label}</div>
                  <p className="text-muted-foreground">{tpl.description}</p>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Import these templates in your Dify editor, then register the API key above
            </p>
          </CardContent>
        </Card>
      )}

      {/* Dify Editor Link */}
      {difyEmbed?.externalUrl && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              Dify Workflow Editor
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-3 p-3 rounded border bg-muted/30">
              <div className="flex-1">
                <p className="text-sm font-medium">Create and edit crew workflows visually</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Open the Dify editor to build multi-agent workflows using drag-and-drop nodes.
                  After creating a workflow, copy its API key and register it as a crew above.
                </p>
              </div>
              <Button
                variant="default"
                onClick={() => window.open("/dify-login", "_blank")}
              >
                <ExternalLink className="h-4 w-4 mr-2" /> Open Editor
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Login: admin@bionic.local
            </p>
          </CardContent>
        </Card>
      )}

      {/* Execution History */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Clock className="h-4 w-4" /> Recent Crew Executions
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!executions || executions.length === 0 ? (
            <p className="text-xs text-muted-foreground">No executions yet</p>
          ) : (
            <div className="space-y-1">
              {executions.map((exec: any) => (
                <div key={exec.id} className="flex items-center gap-2 text-xs py-1 border-b last:border-0">
                  {statusIcon(exec.status)}
                  <span className="font-mono">{exec.difyRunId?.slice(0, 8) || "—"}</span>
                  <span className="text-muted-foreground">
                    {exec.elapsedTimeMs ? `${(exec.elapsedTimeMs / 1000).toFixed(1)}s` : "—"}
                  </span>
                  <span className="text-muted-foreground flex-1 truncate">
                    {typeof exec.taskPayload === "object" && exec.taskPayload
                      ? (exec.taskPayload as any).task || JSON.stringify(exec.taskPayload).slice(0, 50)
                      : "—"}
                  </span>
                  <Badge variant={exec.status === "succeeded" ? "default" : "secondary"} className="text-xs">
                    {exec.status}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
