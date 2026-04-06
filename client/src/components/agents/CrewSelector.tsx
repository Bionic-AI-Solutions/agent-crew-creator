import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Users, Plus } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";

interface Props {
  agentId: number;
  appId: number;
}

export default function CrewSelector({ agentId, appId }: Props) {
  const utils = trpc.useUtils();
  const { data: crews } = trpc.agentsCrud.listCrews.useQuery({ appId });
  const { data: agent } = trpc.agentsCrud.getById.useQuery({ id: agentId });
  const setCrewsMutation = trpc.agentsCrud.setAgentCrews.useMutation({
    onSuccess: () => {
      toast.success("Crews updated");
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

  return (
    <Card>
      <CardHeader className="pb-3 flex flex-row items-center justify-between">
        <CardTitle className="text-sm flex items-center gap-2">
          <Users className="h-4 w-4" /> Crews (Dify)
        </CardTitle>
      </CardHeader>
      <CardContent>
        {!crews || crews.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No crews created yet. Go to the Crews tab to create workflows.
          </p>
        ) : (
          <div className="space-y-2">
            {crews.map((crew) => (
              <label key={crew.id} className="flex items-start gap-2 cursor-pointer">
                <Checkbox
                  checked={selectedCrews.includes(crew.name)}
                  onCheckedChange={() => toggleCrew(crew.name)}
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{crew.name}</span>
                    <Badge variant="outline" className="text-xs">{crew.mode}</Badge>
                  </div>
                  {crew.description && (
                    <p className="text-xs text-muted-foreground">{crew.description}</p>
                  )}
                </div>
              </label>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
