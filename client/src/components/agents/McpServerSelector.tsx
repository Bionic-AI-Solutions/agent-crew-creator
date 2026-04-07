import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Server, Plus } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";

interface Props {
  agentId: number;
  appId: number;
}

export default function McpServerSelector({ agentId, appId }: Props) {
  const utils = trpc.useUtils();
  const { data: servers } = trpc.agentsCrud.listMcpServers.useQuery({ appId });
  const { data: agent } = trpc.agentsCrud.getById.useQuery({ id: agentId });
  const setServersMutation = trpc.agentsCrud.setAgentMcpServers.useMutation({
    onSuccess: () => {
      toast.success("MCP servers updated");
      utils.agentsCrud.getById.invalidate({ id: agentId });
    },
  });

  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [transport, setTransport] = useState("streamable-http");
  const [authType, setAuthType] = useState("none");
  const [apiKey, setApiKey] = useState("");

  const createMutation = trpc.agentsCrud.createMcpServer.useMutation({
    onSuccess: () => {
      toast.success("MCP server added");
      setShowAdd(false);
      setName(""); setUrl(""); setApiKey("");
      utils.agentsCrud.listMcpServers.invalidate({ appId });
    },
  });

  const selectedIds = agent?.mcpServers?.map((m) => m.mcpServerId) || [];

  const toggleServer = (serverId: number) => {
    const newIds = selectedIds.includes(serverId)
      ? selectedIds.filter((id) => id !== serverId)
      : [...selectedIds, serverId];
    setServersMutation.mutate({ agentConfigId: agentId, mcpServerIds: newIds });
  };

  return (
    <Card>
      <CardHeader className="pb-3 flex flex-row items-center justify-between">
        <CardTitle className="text-sm flex items-center gap-2">
          <Server className="h-4 w-4" /> MCP Servers
        </CardTitle>
        <Button size="sm" variant="outline" onClick={() => setShowAdd(true)}>
          <Plus className="h-3 w-3 mr-1" /> Add Server
        </Button>
      </CardHeader>
      <CardContent>
        {!servers || servers.length === 0 ? (
          <p className="text-xs text-muted-foreground">No MCP servers configured for this app</p>
        ) : (
          <div className="space-y-2">
            {servers.map((server) => (
              <label key={server.id} className="flex items-start gap-2 cursor-pointer">
                <Checkbox
                  checked={selectedIds.includes(server.id)}
                  onCheckedChange={() => toggleServer(server.id)}
                />
                <div>
                  <span className="text-sm font-medium">{server.name}</span>
                  <p className="text-xs text-muted-foreground font-mono">{server.url}</p>
                </div>
              </label>
            ))}
          </div>
        )}
      </CardContent>

      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add MCP Server</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="search-server" />
            </div>
            <div>
              <Label>URL</Label>
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/sse" />
            </div>
            <div>
              <Label>Transport</Label>
              <Select value={transport} onValueChange={setTransport}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="streamable-http">Streamable HTTP</SelectItem>
                  <SelectItem value="sse">SSE</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Auth Type</Label>
              <Select value={authType} onValueChange={setAuthType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="api-key">API Key</SelectItem>
                  <SelectItem value="bearer">Bearer Token</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {authType !== "none" && (
              <div>
                <Label>API Key</Label>
                <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
              </div>
            )}
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowAdd(false)}>Cancel</Button>
              <Button
                onClick={() => createMutation.mutate({
                  appId, name, url,
                  transport: transport as "streamable-http" | "sse",
                  authType: authType as "none" | "api-key" | "bearer",
                  apiKey: apiKey || undefined,
                })}
                disabled={!name || !url || createMutation.isPending}
              >
                Add
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
