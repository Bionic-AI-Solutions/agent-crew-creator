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
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Users,
  ExternalLink,
  Sparkles,
  Trash2,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  Plus,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";

interface Props {
  agentId: number;
  appId: number;
}

interface ConfigField {
  key: string;
  label: string;
  type: "text" | "url" | "email" | "textarea";
  required: boolean;
  placeholder?: string;
  description?: string;
}

interface TemplateMeta {
  id: string;
  label: string;
  description: string;
  mode: "workflow" | "agent-chat" | "completion";
  icon?: string;
  configSchema?: ConfigField[];
  postInstall?: "scrape_website" | "none";
}

export default function CrewBuilder({ agentId, appId }: Props) {
  const utils = trpc.useUtils();

  // Queries
  const { data: crews, isLoading: crewsLoading } = trpc.agentsCrud.listCrews.useQuery({ appId });
  const { data: agent } = trpc.agentsCrud.getById.useQuery({ id: agentId });
  const { data: templates } = trpc.agentsCrud.listCrewTemplates.useQuery();
  const { data: difyEmbed } = trpc.agentsCrud.getDifyEmbedUrl.useQuery({ appId });
  const { data: executions } = trpc.agentsCrud.listCrewExecutions.useQuery({
    agentConfigId: agentId,
    limit: 10,
  });

  // Install dialog state
  const [installTpl, setInstallTpl] = useState<TemplateMeta | null>(null);
  const [installConfig, setInstallConfig] = useState<Record<string, string>>({});

  // Advanced "register manually" dialog state — for crews built directly
  // in the Dify editor that don't come from a template.
  const [showManualDialog, setShowManualDialog] = useState(false);
  const [manualName, setManualName] = useState("");
  const [manualDescription, setManualDescription] = useState("");
  const [manualMode, setManualMode] = useState<"workflow" | "agent-chat" | "completion">("workflow");
  const [manualApiKey, setManualApiKey] = useState("");

  // Mutations
  const installMutation = trpc.agentsCrud.installCrewTemplate.useMutation({
    onSuccess: (res) => {
      toast.success(
        res.postInstallStarted
          ? "Crew installed — background setup running"
          : "Crew installed",
      );
      setInstallTpl(null);
      setInstallConfig({});
      utils.agentsCrud.listCrews.invalidate({ appId });
      utils.agentsCrud.getById.invalidate({ id: agentId });
    },
    onError: (err) => toast.error(err.message),
  });

  const deleteCrewMutation = trpc.agentsCrud.deleteCrew.useMutation({
    onSuccess: () => {
      toast.success("Crew deleted");
      utils.agentsCrud.listCrews.invalidate({ appId });
    },
  });

  const createCrewMutation = trpc.agentsCrud.createCrew.useMutation({
    onSuccess: () => {
      toast.success("Crew registered");
      setShowManualDialog(false);
      setManualName("");
      setManualDescription("");
      setManualApiKey("");
      utils.agentsCrud.listCrews.invalidate({ appId });
    },
    onError: (err) => toast.error(err.message),
  });

  const setCrewsMutation = trpc.agentsCrud.setAgentCrews.useMutation({
    onSuccess: () => {
      toast.success("Agent crews updated");
      utils.agentsCrud.getById.invalidate({ id: agentId });
    },
  });

  const selectedCrews = agent?.crews?.map((c) => c.crewName) || [];
  const installedTemplateIds = new Set((crews || []).map((c) => c.name));

  const toggleCrew = (crewName: string) => {
    const newCrews = selectedCrews.includes(crewName)
      ? selectedCrews.filter((c) => c !== crewName)
      : [...selectedCrews, crewName];
    setCrewsMutation.mutate({ agentConfigId: agentId, crewNames: newCrews });
  };

  const openInstall = (tpl: TemplateMeta) => {
    setInstallTpl(tpl);
    const initial: Record<string, string> = {};
    (tpl.configSchema || []).forEach((f) => {
      initial[f.key] = "";
    });
    setInstallConfig(initial);
  };

  const handleManualRegister = () => {
    const slug = manualName.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
    if (!slug) {
      toast.error("Name is required");
      return;
    }
    createCrewMutation.mutate({
      appId,
      name: slug,
      description: manualDescription || undefined,
      mode: manualMode,
      difyAppApiKey: manualApiKey || undefined,
    });
  };

  const handleInstall = () => {
    if (!installTpl) return;
    const missing = (installTpl.configSchema || []).find(
      (f) => f.required && !installConfig[f.key]?.trim(),
    );
    if (missing) {
      toast.error(`Missing required field: ${missing.label}`);
      return;
    }
    installMutation.mutate({
      agentConfigId: agentId,
      templateId: installTpl.id,
      config: installConfig,
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
      {/* ── Section 1: Installed Crews ─────────────────────────── */}
      <Card>
        <CardHeader className="pb-3 flex flex-row items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Users className="h-4 w-4" /> Crews
          </CardTitle>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowManualDialog(true)}
              title="Register a Dify workflow you built by hand"
            >
              <Plus className="h-3 w-3 mr-1" /> Advanced
            </Button>
            {difyEmbed?.externalUrl && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => window.open("/dify-login", "_blank")}
                title="Open Dify to customise installed crews"
              >
                <ExternalLink className="h-3 w-3 mr-1" /> Open Dify Editor
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {crewsLoading ? (
            <p className="text-xs text-muted-foreground">Loading crews...</p>
          ) : !crews || crews.length === 0 ? (
            <div className="text-center py-6">
              <p className="text-sm text-muted-foreground mb-1">No crews installed yet</p>
              <p className="text-xs text-muted-foreground">
                Pick a template below to install one with a single click.
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
                        <Badge variant="default" className="text-xs bg-green-600">
                          ready
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-xs">
                          no API key
                        </Badge>
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

      {/* ── Section 2: Template Gallery ────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Sparkles className="h-4 w-4" /> Crew Templates
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!templates || templates.length === 0 ? (
            <p className="text-xs text-muted-foreground">No templates available</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {(templates as TemplateMeta[]).map((tpl) => {
                const installed = installedTemplateIds.has(tpl.id);
                const requiresConfig = (tpl.configSchema || []).some((f) => f.required);
                return (
                  <div
                    key={tpl.id}
                    className="p-3 rounded border flex flex-col gap-2 bg-card"
                  >
                    <div className="flex items-start gap-2">
                      <span className="text-xl leading-none">{tpl.icon || "✨"}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium">{tpl.label}</span>
                          <Badge variant="outline" className="text-xs">
                            {tpl.mode}
                          </Badge>
                          {requiresConfig && (
                            <Badge variant="secondary" className="text-xs">
                              config
                            </Badge>
                          )}
                          {tpl.postInstall === "scrape_website" && (
                            <Badge variant="secondary" className="text-xs">
                              scrapes site
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">
                          {tpl.description}
                        </p>
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant={installed ? "outline" : "default"}
                      onClick={() => openInstall(tpl)}
                      disabled={installMutation.isPending}
                    >
                      {installed ? "Reinstall" : "Install"}
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Section 3: Execution History ───────────────────────── */}
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
                <div
                  key={exec.id}
                  className="flex items-center gap-2 text-xs py-1 border-b last:border-0"
                >
                  {statusIcon(exec.status)}
                  <span className="font-mono">{exec.difyRunId?.slice(0, 8) || "—"}</span>
                  <span className="text-muted-foreground">
                    {exec.elapsedTimeMs
                      ? `${(exec.elapsedTimeMs / 1000).toFixed(1)}s`
                      : "—"}
                  </span>
                  <span className="text-muted-foreground flex-1 truncate">
                    {typeof exec.taskPayload === "object" && exec.taskPayload
                      ? (exec.taskPayload as any).task ||
                        JSON.stringify(exec.taskPayload).slice(0, 50)
                      : "—"}
                  </span>
                  <Badge
                    variant={exec.status === "succeeded" ? "default" : "secondary"}
                    className="text-xs"
                  >
                    {exec.status}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Advanced: Register manually ────────────────────────── */}
      <Dialog open={showManualDialog} onOpenChange={setShowManualDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Register Crew Manually</DialogTitle>
            <DialogDescription>
              For Dify workflows you built directly in the editor. Paste the
              app's API key here so the agent can call it. For most use cases,
              prefer one-click templates below.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">Name</label>
              <Input
                placeholder="my_custom_crew"
                value={manualName}
                onChange={(e) => setManualName(e.target.value)}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Lowercase, underscores only
              </p>
            </div>
            <div>
              <label className="text-sm font-medium">Description</label>
              <Textarea
                placeholder="What does this crew do?"
                value={manualDescription}
                onChange={(e) => setManualDescription(e.target.value)}
                rows={2}
              />
            </div>
            <div>
              <label className="text-sm font-medium">Mode</label>
              <Select
                value={manualMode}
                onValueChange={(v) =>
                  setManualMode(v as "workflow" | "agent-chat" | "completion")
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="workflow">Workflow</SelectItem>
                  <SelectItem value="agent-chat">Agent Chat</SelectItem>
                  <SelectItem value="completion">Completion</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium">Dify App API Key</label>
              <Input
                type="password"
                placeholder="app-xxxxxxxx"
                value={manualApiKey}
                onChange={(e) => setManualApiKey(e.target.value)}
              />
              <p className="text-xs text-muted-foreground mt-1">
                From the Dify console → your app → API Access
              </p>
            </div>
            <Button
              onClick={handleManualRegister}
              disabled={createCrewMutation.isPending || !manualName}
              className="w-full"
            >
              {createCrewMutation.isPending ? "Registering…" : "Register Crew"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Install Dialog ─────────────────────────────────────── */}
      <Dialog open={Boolean(installTpl)} onOpenChange={(o) => !o && setInstallTpl(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span className="text-xl">{installTpl?.icon}</span>
              Install: {installTpl?.label}
            </DialogTitle>
            <DialogDescription>{installTpl?.description}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {(installTpl?.configSchema || []).length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No configuration needed. Click Install to deploy this crew into Dify and
                attach it to the agent.
              </p>
            ) : (
              (installTpl?.configSchema || []).map((field) => (
                <div key={field.key}>
                  <label className="text-sm font-medium">
                    {field.label}
                    {field.required && <span className="text-red-500 ml-1">*</span>}
                  </label>
                  {field.type === "textarea" ? (
                    <Textarea
                      placeholder={field.placeholder}
                      value={installConfig[field.key] || ""}
                      onChange={(e) =>
                        setInstallConfig({ ...installConfig, [field.key]: e.target.value })
                      }
                      rows={3}
                    />
                  ) : (
                    <Input
                      type={field.type === "email" ? "email" : "text"}
                      placeholder={field.placeholder}
                      value={installConfig[field.key] || ""}
                      onChange={(e) =>
                        setInstallConfig({ ...installConfig, [field.key]: e.target.value })
                      }
                    />
                  )}
                  {field.description && (
                    <p className="text-xs text-muted-foreground mt-1">{field.description}</p>
                  )}
                </div>
              ))
            )}
            <Button
              onClick={handleInstall}
              disabled={installMutation.isPending}
              className="w-full"
            >
              {installMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Installing…
                </>
              ) : (
                "Install Crew"
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
