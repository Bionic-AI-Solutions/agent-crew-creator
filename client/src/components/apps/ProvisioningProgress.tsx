import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCircle, XCircle, Clock, Loader2, RotateCcw, SkipForward } from "lucide-react";

interface ProvisioningStep {
  name: string;
  label: string;
  status: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

interface Props {
  job: {
    id: number;
    jobType: string;
    status: string;
    steps: ProvisioningStep[];
    error?: string | null;
  };
  onRetry: () => void;
}

function StepIcon({ status }: { status: string }) {
  switch (status) {
    case "success": return <CheckCircle className="h-4 w-4 text-green-500" />;
    case "failed": return <XCircle className="h-4 w-4 text-red-500" />;
    case "running": return <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />;
    case "skipped": return <SkipForward className="h-4 w-4 text-muted-foreground" />;
    default: return <Clock className="h-4 w-4 text-muted-foreground" />;
  }
}

export default function ProvisioningProgress({ job, onRetry }: Props) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-lg capitalize">{job.jobType} Job #{job.id}</CardTitle>
        </div>
        <div className="flex items-center gap-2">
          <Badge
            className={
              job.status === "completed" ? "bg-green-500 text-white" :
              job.status === "failed" ? "bg-red-500 text-white" :
              job.status === "running" ? "bg-blue-500 text-white" : ""
            }
          >
            {job.status}
          </Badge>
          {job.status === "failed" && (
            <Button size="sm" variant="outline" onClick={onRetry}>
              <RotateCcw className="h-3 w-3 mr-1" /> Retry
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {(job.steps as ProvisioningStep[]).map((step) => (
            <div key={step.name} className="flex items-center gap-3 text-sm">
              <StepIcon status={step.status} />
              <span className={step.status === "skipped" ? "text-muted-foreground line-through" : ""}>
                {step.label}
              </span>
              {step.error && (
                <span className="text-xs text-red-400 ml-auto">{step.error}</span>
              )}
            </div>
          ))}
        </div>
        {job.error && (
          <p className="mt-4 text-sm text-red-400 border border-red-500/30 rounded p-2">{job.error}</p>
        )}
      </CardContent>
    </Card>
  );
}
