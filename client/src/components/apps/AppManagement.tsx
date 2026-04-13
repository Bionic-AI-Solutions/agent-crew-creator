import { useState } from "react";
import { useLocation } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { Trash2, Bot, ExternalLink, CheckCircle, XCircle, Clock, RotateCcw } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useAppContext } from "@/contexts/AppContext";
import ProvisioningProgress from "./ProvisioningProgress";

interface Props {
  slug: string;
  onDelete: () => void;
}

export default function AppManagement({ slug, onDelete }: Props) {
  const [, setLocation] = useLocation();
  const { setSelectedAppId, setSelectedAppSlug } = useAppContext();
  const { data: app, refetch } = trpc.appsCrud.getBySlug.useQuery({ slug }, {
    refetchInterval: (query) => {
      const status = (query.state.data as any)?.provisioningStatus;
      return status === "provisioning" || status === "deleting" ? 2000 : false;
    },
  });
  const { data: job } = trpc.appsCrud.getProvisioningJob.useQuery(
    { appId: app?.id || 0 },
    {
      enabled: !!app?.id,
      refetchInterval: app?.provisioningStatus === "provisioning" || app?.provisioningStatus === "deleting" ? 2000 : false,
    },
  );
  const { data: agents } = trpc.agentsCrud.list.useQuery(
    { appId: app?.id || 0 },
    { enabled: !!app?.id },
  );

  const deleteMutation = trpc.appsCrud.delete.useMutation({
    onSuccess: () => { toast.success("App deletion started"); onDelete(); },
    onError: (err) => toast.error(err.message),
  });

  const retryMutation = trpc.appsCrud.retryProvisioning.useMutation({
    onSuccess: () => { toast.success("Retrying provisioning..."); refetch(); },
    onError: (err) => toast.error(err.message),
  });

  if (!app) return <div className="text-muted-foreground">Loading...</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{app.name}</h1>
          <p className="text-muted-foreground font-mono text-sm">{app.slug}</p>
        </div>
        <Badge
          className={
            app.provisioningStatus === "completed" ? "bg-green-500 text-white" :
            app.provisioningStatus === "failed" ? "bg-red-500 text-white" :
            app.provisioningStatus === "provisioning" ? "bg-blue-500 text-white animate-pulse" :
            ""
          }
        >
          {app.provisioningStatus}
        </Badge>
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="services">Services</TabsTrigger>
          <TabsTrigger value="agents">Agents ({agents?.length || 0})</TabsTrigger>
          <TabsTrigger value="provisioning">Provisioning</TabsTrigger>
          <TabsTrigger value="danger">Danger Zone</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <Card>
            <CardContent className="pt-6 space-y-3 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Status</span><span>{app.provisioningStatus}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">LiveKit URL</span><span className="font-mono text-xs">{app.livekitUrl}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">API Key</span><span className="font-mono text-xs">{app.apiKeyPrefix}</span></div>
              {app.roomPrefix && <div className="flex justify-between"><span className="text-muted-foreground">Room Prefix</span><span>{app.roomPrefix}</span></div>}
              <div className="flex justify-between"><span className="text-muted-foreground">Created</span><span>{new Date(app.createdAt).toLocaleDateString()}</span></div>
              {(app.enabledServices as string[]).includes("player_ui") && (
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">Web URL</span>
                  <a
                    href={`https://${app.slug}.baisoln.com`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-xs text-blue-400 hover:underline flex items-center gap-1"
                  >
                    {app.slug}.baisoln.com
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              )}
              {app.description && <div className="pt-2"><span className="text-muted-foreground">Description:</span><p className="mt-1">{app.description}</p></div>}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="services">
          <Card>
            <CardContent className="pt-6 space-y-2">
              {(app.enabledServices as string[]).map((svc) => (
                <div key={svc} className="flex items-center gap-2 text-sm">
                  <CheckCircle className="h-4 w-4 text-green-500" />
                  <span className="capitalize">{svc}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="agents">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-lg">Agents</CardTitle>
              <Button
                size="sm"
                onClick={() => {
                  setSelectedAppId(app.id);
                  setSelectedAppSlug(app.slug);
                  setLocation("/agents");
                }}
              >
                <Bot className="h-4 w-4 mr-1" /> Agent Builder
              </Button>
            </CardHeader>
            <CardContent>
              {!agents || agents.length === 0 ? (
                <p className="text-muted-foreground text-sm">No agents yet. Use Agent Builder to create one.</p>
              ) : (
                <div className="space-y-2">
                  {agents.map((agent) => (
                    <div
                      key={agent.id}
                      className="flex items-center justify-between rounded-md border px-3 py-2 cursor-pointer hover:bg-muted/30"
                      onClick={() => {
                        setSelectedAppId(app.id);
                        setSelectedAppSlug(app.slug);
                        setLocation("/agents");
                      }}
                    >
                      <div className="flex items-center gap-2">
                        <Bot className="h-4 w-4" />
                        <span className="font-medium text-sm">{agent.name}</span>
                      </div>
                      <Badge variant={agent.deployed ? "default" : "secondary"} className="text-xs">
                        {agent.deploymentStatus || (agent.deployed ? "running" : "stopped")}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="provisioning">
          {job ? (
            <ProvisioningProgress job={job} onRetry={() => retryMutation.mutate({ jobId: job.id })} />
          ) : (
            <Card><CardContent className="pt-6 text-sm text-muted-foreground">No provisioning jobs found.</CardContent></Card>
          )}
        </TabsContent>

        <TabsContent value="danger">
          <Card className="border-destructive/50">
            <CardHeader>
              <CardTitle className="text-destructive">Danger Zone</CardTitle>
              <CardDescription>These actions cannot be undone</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between rounded-md border border-destructive/30 p-4">
                <div>
                  <p className="font-medium">Delete App</p>
                  <p className="text-sm text-muted-foreground">Permanently delete this app and all its resources</p>
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => {
                    if (confirm(`Delete "${app.name}"? This will remove all namespaces, databases, secrets, and agents.`)) {
                      deleteMutation.mutate({ id: app.id });
                    }
                  }}
                  disabled={deleteMutation.isPending}
                >
                  <Trash2 className="h-4 w-4 mr-1" /> Delete
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
