import { useState } from "react";
import { useRoute, useLocation } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus, ArrowLeft, Video, Shield, BarChart3, Server, Database, HardDrive, Brain } from "lucide-react";
import { trpc } from "@/lib/trpc";
import AppWizard from "@/components/apps/AppWizard";
import AppManagement from "@/components/apps/AppManagement";

const SERVICE_ICON_MAP: Record<string, React.ReactNode> = {
  livekit: <Video className="h-3.5 w-3.5" />,
  keycloak: <Shield className="h-3.5 w-3.5" />,
  langfuse: <BarChart3 className="h-3.5 w-3.5" />,
  kubernetes: <Server className="h-3.5 w-3.5" />,
  postgres: <Database className="h-3.5 w-3.5" />,
  redis: <Database className="h-3.5 w-3.5" />,
  minio: <HardDrive className="h-3.5 w-3.5" />,
  letta: <Brain className="h-3.5 w-3.5" />,
};

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "completed":
      return <Badge className="bg-green-500 text-white">Provisioned</Badge>;
    case "provisioning":
      return <Badge className="bg-blue-500 text-white animate-pulse">Provisioning</Badge>;
    case "failed":
      return <Badge variant="destructive">Failed</Badge>;
    case "deleting":
      return <Badge className="bg-orange-500 text-white">Deleting</Badge>;
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
}

type ViewMode = "list" | "wizard" | "detail";

export default function Apps() {
  const [, params] = useRoute("/apps/:slug");
  const [, setLocation] = useLocation();
  const [viewMode, setViewMode] = useState<ViewMode>(params?.slug ? "detail" : "list");
  const [selectedSlug, setSelectedSlug] = useState<string | null>(params?.slug || null);

  // Auto-poll every 3s when any app is actively provisioning or deleting
  const { data: apps, refetch } = trpc.appsCrud.list.useQuery(undefined, {
    refetchInterval: (query) => {
      const data = query.state.data as any[];
      if (!data) return false;
      const hasActive = data.some((a: any) =>
        a.provisioningStatus === "provisioning" || a.provisioningStatus === "deleting"
      );
      return hasActive ? 3000 : false;
    },
  });

  if (viewMode === "wizard") {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" onClick={() => setViewMode("list")}>
            <ArrowLeft className="h-4 w-4 mr-1" /> Back
          </Button>
          <h1 className="text-2xl font-bold">Create App</h1>
        </div>
        <AppWizard
          onComplete={() => {
            refetch();
            setViewMode("list");
          }}
          onCancel={() => setViewMode("list")}
        />
      </div>
    );
  }

  if (viewMode === "detail" && selectedSlug) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setViewMode("list");
              setSelectedSlug(null);
              setLocation("/apps");
            }}
          >
            <ArrowLeft className="h-4 w-4 mr-1" /> Back to Apps
          </Button>
        </div>
        <AppManagement
          slug={selectedSlug}
          onDelete={() => {
            refetch();
            setViewMode("list");
            setSelectedSlug(null);
          }}
        />
      </div>
    );
  }

  // List view
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Apps</h1>
          <p className="text-muted-foreground">Manage your applications and their infrastructure</p>
        </div>
        <Button onClick={() => setViewMode("wizard")}>
          <Plus className="h-4 w-4 mr-1" /> Create App
        </Button>
      </div>

      {!apps || apps.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <p className="text-muted-foreground mb-4">No apps yet. Create your first app to get started.</p>
            <Button onClick={() => setViewMode("wizard")}>
              <Plus className="h-4 w-4 mr-1" /> Create App
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="rounded-md border">
          <table className="w-full">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left text-sm font-medium">Name</th>
                <th className="px-4 py-3 text-left text-sm font-medium">Slug</th>
                <th className="px-4 py-3 text-left text-sm font-medium">Services</th>
                <th className="px-4 py-3 text-left text-sm font-medium">Status</th>
                <th className="px-4 py-3 text-left text-sm font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {apps.map((app) => (
                <tr
                  key={app.id}
                  className="border-b cursor-pointer hover:bg-muted/30 transition-colors"
                  onClick={() => {
                    setSelectedSlug(app.slug);
                    setViewMode("detail");
                    setLocation(`/apps/${app.slug}`);
                  }}
                >
                  <td className="px-4 py-3 font-medium">{app.name}</td>
                  <td className="px-4 py-3 text-muted-foreground font-mono text-sm">{app.slug}</td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1">
                      {(app.enabledServices as string[]).map((svc) => (
                        <span key={svc} className="text-muted-foreground" title={svc}>
                          {SERVICE_ICON_MAP[svc] || svc}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={app.provisioningStatus} />
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">
                    {new Date(app.createdAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
