import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Server, Plus, Trash2 } from "lucide-react";
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
  const deleteMutation = trpc.agentsCrud.deleteMcpServer.useMutation({
    onSuccess: () => {
      toast.success("MCP server deleted");
      utils.agentsCrud.listMcpServers.invalidate({ appId });
      utils.agentsCrud.getById.invalidate({ id: agentId });
    },
    onError: (err) => toast.error(err.message),
  });

  const [showAdd, setShowAdd] = useState(false);
  const [addMode, setAddMode] = useState<"form" | "json">("form");

  // Form mode state
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [transport, setTransport] = useState("streamable-http");
  const [authType, setAuthType] = useState("none");
  const [apiKey, setApiKey] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const [headers, setHeaders] = useState("");

  // JSON mode state
  const [jsonConfig, setJsonConfig] = useState("");
  const [jsonError, setJsonError] = useState("");

  const createMutation = trpc.agentsCrud.createMcpServer.useMutation({
    onSuccess: () => {
      toast.success("MCP server added");
      setShowAdd(false);
      resetForm();
      utils.agentsCrud.listMcpServers.invalidate({ appId });
    },
    onError: (err) => toast.error(err.message),
  });

  const selectedIds = agent?.mcpServers?.map((m: any) => m.mcpServerId) || [];

  const toggleServer = (serverId: number) => {
    const newIds = selectedIds.includes(serverId)
      ? selectedIds.filter((id: number) => id !== serverId)
      : [...selectedIds, serverId];
    setServersMutation.mutate({ agentConfigId: agentId, mcpServerIds: newIds });
  };

  const resetForm = () => {
    setName(""); setUrl(""); setCommand(""); setArgs(""); setEnv("");
    setHeaders(""); setApiKey(""); setTransport("streamable-http");
    setAuthType("none"); setJsonConfig(""); setJsonError("");
  };

  const handleJsonSubmit = () => {
    try {
      const config = JSON.parse(jsonConfig);
      // Support formats: { "mcpServers": { "name": { ... } } } or { "name": { ... } } or { url, transport, ... }
      let serverName = "";
      let serverConfig: any = {};

      if (config.mcpServers) {
        // Claude/Cursor format: { "mcpServers": { "server-name": { ... } } }
        const entries = Object.entries(config.mcpServers);
        if (entries.length === 0) { setJsonError("No servers found in mcpServers"); return; }
        [serverName, serverConfig] = entries[0] as [string, any];
      } else if (config.command || config.url) {
        // Direct config: { command: "...", args: [...] } or { url: "..." }
        serverName = config.name || "mcp-server";
        serverConfig = config;
      } else {
        // Wrapped: { "server-name": { command/url: ... } }
        const entries = Object.entries(config);
        if (entries.length === 0) { setJsonError("Empty config"); return; }
        [serverName, serverConfig] = entries[0] as [string, any];
      }

      const isStdio = !!serverConfig.command;
      createMutation.mutate({
        appId,
        name: serverName,
        url: serverConfig.url || undefined,
        transport: isStdio ? "stdio" : (serverConfig.transport || "streamable-http"),
        authType: serverConfig.apiKey ? "api-key" : "none",
        apiKey: serverConfig.apiKey || undefined,
        command: serverConfig.command || undefined,
        args: serverConfig.args ? JSON.stringify(serverConfig.args) : undefined,
        env: serverConfig.env ? JSON.stringify(serverConfig.env) : undefined,
        headers: serverConfig.headers ? JSON.stringify(serverConfig.headers) : undefined,
      });
    } catch (e: any) {
      setJsonError(`Invalid JSON: ${e.message}`);
    }
  };

  const handleFormSubmit = () => {
    createMutation.mutate({
      appId, name, url: url || undefined,
      transport: transport as any,
      authType: authType as any,
      apiKey: apiKey || undefined,
      command: command || undefined,
      args: args || undefined,
      env: env || undefined,
      headers: headers || undefined,
    });
  };

  return (
    <Card>
      <CardHeader className="pb-3 flex flex-row items-center justify-between">
        <CardTitle className="text-sm flex items-center gap-2">
          <Server className="h-4 w-4" /> MCP Servers
        </CardTitle>
        <Button size="sm" variant="outline" onClick={() => { resetForm(); setShowAdd(true); }}>
          <Plus className="h-3 w-3 mr-1" /> Add Server
        </Button>
      </CardHeader>
      <CardContent>
        {!servers || servers.length === 0 ? (
          <p className="text-xs text-muted-foreground">No MCP servers configured for this app</p>
        ) : (
          <div className="space-y-2">
            {servers.map((server: any) => (
              <div key={server.id} className="flex items-start gap-2 group">
                <Checkbox
                  checked={selectedIds.includes(server.id)}
                  onCheckedChange={() => toggleServer(server.id)}
                />
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium">{server.name}</span>
                  <p className="text-xs text-muted-foreground font-mono truncate">
                    {server.url || server.command || server.transport}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="opacity-0 group-hover:opacity-100 transition-opacity h-6 w-6 p-0 text-destructive"
                  onClick={() => {
                    if (confirm(`Delete MCP server "${server.name}"?`)) {
                      deleteMutation.mutate({ id: server.id });
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

      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add MCP Server</DialogTitle>
          </DialogHeader>

          <Tabs value={addMode} onValueChange={(v) => setAddMode(v as "form" | "json")}>
            <TabsList className="w-full">
              <TabsTrigger value="form" className="flex-1">Form</TabsTrigger>
              <TabsTrigger value="json" className="flex-1">JSON Config</TabsTrigger>
            </TabsList>

            <TabsContent value="form" className="space-y-3 mt-3">
              <div>
                <Label className="text-xs">Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="search-server" />
              </div>
              <div>
                <Label className="text-xs">Transport</Label>
                <Select value={transport} onValueChange={setTransport}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="streamable-http">Streamable HTTP</SelectItem>
                    <SelectItem value="sse">SSE</SelectItem>
                    <SelectItem value="stdio">Stdio (Command)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {transport !== "stdio" ? (
                <>
                  <div>
                    <Label className="text-xs">URL</Label>
                    <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/sse" />
                  </div>
                  <div>
                    <Label className="text-xs">Headers (JSON)</Label>
                    <Input value={headers} onChange={(e) => setHeaders(e.target.value)} placeholder='{"X-API-Key": "..."}' />
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <Label className="text-xs">Command</Label>
                    <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" />
                  </div>
                  <div>
                    <Label className="text-xs">Arguments (JSON array)</Label>
                    <Input value={args} onChange={(e) => setArgs(e.target.value)} placeholder='["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]' />
                  </div>
                  <div>
                    <Label className="text-xs">Environment (JSON)</Label>
                    <Input value={env} onChange={(e) => setEnv(e.target.value)} placeholder='{"NODE_ENV": "production"}' />
                  </div>
                </>
              )}

              <div>
                <Label className="text-xs">Auth Type</Label>
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
                  <Label className="text-xs">API Key / Token</Label>
                  <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
                </div>
              )}

              <div className="flex gap-2 justify-end pt-2">
                <Button variant="outline" onClick={() => setShowAdd(false)}>Cancel</Button>
                <Button
                  onClick={handleFormSubmit}
                  disabled={!name || (transport !== "stdio" && !url) || (transport === "stdio" && !command) || createMutation.isPending}
                >
                  Add
                </Button>
              </div>
            </TabsContent>

            <TabsContent value="json" className="space-y-3 mt-3">
              <div>
                <Label className="text-xs">Paste MCP Server JSON</Label>
                <p className="text-[10px] text-muted-foreground mb-2">
                  Supports Claude/Cursor format, or direct config. Examples:
                </p>
                <Textarea
                  rows={10}
                  value={jsonConfig}
                  onChange={(e) => { setJsonConfig(e.target.value); setJsonError(""); }}
                  placeholder={`{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  }
}`}
                  className="font-mono text-xs"
                />
                {jsonError && <p className="text-xs text-destructive">{jsonError}</p>}
              </div>
              <div className="flex gap-2 justify-end pt-2">
                <Button variant="outline" onClick={() => setShowAdd(false)}>Cancel</Button>
                <Button
                  onClick={handleJsonSubmit}
                  disabled={!jsonConfig.trim() || createMutation.isPending}
                >
                  Add from JSON
                </Button>
              </div>
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
