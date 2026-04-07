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
} from "lucide-react";
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
