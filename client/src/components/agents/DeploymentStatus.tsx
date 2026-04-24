import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Rocket, Square, RotateCcw, CheckCircle, XCircle, Clock } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";

interface Props {
  agentId: number;
  agent: {
    deployed: boolean;
    deploymentStatus: string | null;
    imageTag: string | null;
    lastDeployedAt: string | Date | null;
  };
}

function StatusIndicator({ status }: { status: string | null }) {
  switch (status) {
    case "running": return <Badge className="bg-green-500 text-white">Running</Badge>;
    case "deploying": return <Badge className="bg-blue-500 text-white animate-pulse">Deploying</Badge>;
    case "failed": return <Badge variant="destructive">Failed</Badge>;
    case "stopped": return <Badge variant="secondary">Stopped</Badge>;
    default: return <Badge variant="outline">Not Deployed</Badge>;
  }
}

export default function DeploymentStatus({ agentId, agent }: Props) {
  const utils = trpc.useUtils();
  const { data: status } = trpc.agentsCrud.getDeploymentStatus.useQuery(
    { id: agentId },
    {
      enabled: agent.deployed,
      // Poll every 3s while deploying, stop once running/stopped
      refetchInterval: (query) => {
        const s = (query.state.data as any)?.status;
        return s === "deploying" || agent.deploymentStatus === "deploying" ? 3000 : false;
      },
    },
  );

  // Use live K8s status when available, fall back to DB status
  const liveStatus = status?.status || agent.deploymentStatus;

  const deployMutation = trpc.agentsCrud.deploy.useMutation({
    onSuccess: () => {
      toast.success("Deployment started");
      utils.agentsCrud.getById.invalidate({ id: agentId });
      utils.agentsCrud.getDeploymentStatus.invalidate({ id: agentId });
      utils.agentsCrud.list.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const undeployMutation = trpc.agentsCrud.undeploy.useMutation({
    onSuccess: () => {
      toast.success("Agent stopped");
      utils.agentsCrud.getById.invalidate({ id: agentId });
      utils.agentsCrud.getDeploymentStatus.invalidate({ id: agentId });
      utils.agentsCrud.list.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Deployment</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Status</span>
          <StatusIndicator status={liveStatus} />
        </div>

        {status && (
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Replicas</span>
            <span className="text-sm">{status.message}</span>
          </div>
        )}

        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Image Tag</span>
          <span className="text-sm font-mono">{agent.imageTag || "latest"}</span>
        </div>

        {agent.lastDeployedAt && (
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Last Deployed</span>
            <span className="text-sm">{new Date(agent.lastDeployedAt).toLocaleString()}</span>
          </div>
        )}

        <div className="flex gap-2 pt-2">
          <Button
            size="sm"
            onClick={() => deployMutation.mutate({ id: agentId })}
            disabled={deployMutation.isPending}
          >
            <Rocket className="h-3 w-3 mr-1" />
            {agent.deployed ? "Redeploy" : "Deploy"}
          </Button>
          {agent.deployed && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => undeployMutation.mutate({ id: agentId })}
              disabled={undeployMutation.isPending}
            >
              <Square className="h-3 w-3 mr-1" /> Stop
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
