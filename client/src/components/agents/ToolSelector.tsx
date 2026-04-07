import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Wrench, Plus } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";

interface Props {
  agentId: number;
  appId: number;
}

export default function ToolSelector({ agentId, appId }: Props) {
  const utils = trpc.useUtils();
  const { data: availableTools } = trpc.agentsCrud.listAvailableTools.useQuery({ appId });
  const { data: agent } = trpc.agentsCrud.getById.useQuery({ id: agentId });
  const setToolsMutation = trpc.agentsCrud.setAgentTools.useMutation({
    onSuccess: () => {
      toast.success("Tools updated");
      utils.agentsCrud.getById.invalidate({ id: agentId });
    },
  });

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newType, setNewType] = useState("letta");

  const createMutation = trpc.agentsCrud.createCustomTool.useMutation({
    onSuccess: () => {
      toast.success("Tool created");
      setShowCreate(false);
      setNewName("");
      setNewDesc("");
      utils.agentsCrud.listAvailableTools.invalidate({ appId });
    },
  });

  const selectedToolIds = agent?.tools?.map((t) => t.toolId) || [];

  const toggleTool = (toolId: string) => {
    const newIds = selectedToolIds.includes(toolId)
      ? selectedToolIds.filter((id) => id !== toolId)
      : [...selectedToolIds, toolId];
    setToolsMutation.mutate({ agentConfigId: agentId, toolIds: newIds });
  };

  return (
    <Card>
      <CardHeader className="pb-3 flex flex-row items-center justify-between">
        <CardTitle className="text-sm flex items-center gap-2">
          <Wrench className="h-4 w-4" /> Tools
        </CardTitle>
        <Button size="sm" variant="outline" onClick={() => setShowCreate(true)}>
          <Plus className="h-3 w-3 mr-1" /> Create Tool
        </Button>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {(availableTools || []).map((tool) => (
            <label key={tool.id || tool.name} className="flex items-start gap-2 cursor-pointer">
              <Checkbox
                checked={selectedToolIds.includes(String(tool.id || tool.name))}
                onCheckedChange={() => toggleTool(String(tool.id || tool.name))}
              />
              <div>
                <span className="text-sm font-medium">{tool.name}</span>
                <span className="text-xs text-muted-foreground ml-1">({tool.source})</span>
                {tool.description && <p className="text-xs text-muted-foreground">{tool.description}</p>}
              </div>
            </label>
          ))}
        </div>
      </CardContent>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Custom Tool</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Name</Label>
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="my_tool" />
            </div>
            <div>
              <Label>Description</Label>
              <Input value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder="What this tool does" />
            </div>
            <div>
              <Label>Type</Label>
              <Select value={newType} onValueChange={setNewType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="letta">Letta (Python function)</SelectItem>
                  <SelectItem value="mcp">MCP (Remote tool)</SelectItem>
                  <SelectItem value="http">HTTP (REST endpoint)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
              <Button
                onClick={() => createMutation.mutate({
                  appId,
                  name: newName,
                  description: newDesc,
                  toolType: newType as "letta" | "mcp" | "http",
                  definition: { type: newType },
                })}
                disabled={!newName || createMutation.isPending}
              >
                Create
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
