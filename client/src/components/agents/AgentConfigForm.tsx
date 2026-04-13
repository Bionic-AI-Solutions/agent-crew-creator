import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { Rocket, Trash2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useAppContext } from "@/contexts/AppContext";
import LiveKitSection from "./LiveKitSection";
import LettaSection from "./LettaSection";
import CrewBuilder from "./CrewBuilder";
import DeploymentStatus from "./DeploymentStatus";
import EmbedSection from "./EmbedSection";

interface Props {
  agentId: number;
}

export default function AgentConfigForm({ agentId }: Props) {
  const { setSelectedAgentId } = useAppContext();
  const utils = trpc.useUtils();
  const { data: agent, isLoading } = trpc.agentsCrud.getById.useQuery({ id: agentId });

  // Local form state
  const [sttProvider, setSttProvider] = useState("");
  const [sttModel, setSttModel] = useState("");
  const [llmProvider, setLlmProvider] = useState("");
  const [llmModel, setLlmModel] = useState("");
  const [ttsProvider, setTtsProvider] = useState("");
  const [ttsVoice, setTtsVoice] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [avatarEnabled, setAvatarEnabled] = useState(false);
  const [visionEnabled, setVisionEnabled] = useState(false);
  const [backgroundAudioEnabled, setBackgroundAudioEnabled] = useState(false);
  const [busyAudioEnabled, setBusyAudioEnabled] = useState(false);
  const [lettaAgentName, setLettaAgentName] = useState("");
  const [lettaLlmModel, setLettaLlmModel] = useState("");
  const [lettaSystemPrompt, setLettaSystemPrompt] = useState("");

  // Sync form state when agent data loads
  useEffect(() => {
    if (agent) {
      setSttProvider(agent.sttProvider);
      setSttModel(agent.sttModel || "");
      setLlmProvider(agent.llmProvider);
      setLlmModel(agent.llmModel || "");
      setTtsProvider(agent.ttsProvider);
      setTtsVoice(agent.ttsVoice || "");
      setSystemPrompt(agent.systemPrompt || "");
      setAvatarEnabled(agent.avatarEnabled);
      setVisionEnabled(agent.visionEnabled);
      setBackgroundAudioEnabled(agent.backgroundAudioEnabled);
      setBusyAudioEnabled((agent as any).busyAudioEnabled ?? false);
      setLettaAgentName(agent.lettaAgentName || "");
      setLettaLlmModel(agent.lettaLlmModel || "");
      setLettaSystemPrompt(agent.lettaSystemPrompt || "");
    }
  }, [agent]);

  const updateMutation = trpc.agentsCrud.update.useMutation({
    onSuccess: () => {
      toast.success("Agent saved");
      utils.agentsCrud.getById.invalidate({ id: agentId });
    },
    onError: (err) => toast.error(err.message),
  });

  const deployMutation = trpc.agentsCrud.deploy.useMutation({
    onSuccess: () => {
      toast.success("Deployment started");
      utils.agentsCrud.getById.invalidate({ id: agentId });
    },
    onError: (err) => toast.error(err.message),
  });

  const deleteMutation = trpc.agentsCrud.delete.useMutation({
    onSuccess: () => {
      toast.success("Agent deleted");
      setSelectedAgentId(null);
      utils.agentsCrud.list.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const handleDeploy = () => {
    // Save all fields first, then deploy (which auto-provisions Letta if needed)
    updateMutation.mutate(
      {
        id: agentId,
        sttProvider,
        sttModel: sttModel || null,
        llmProvider,
        llmModel: llmModel || null,
        ttsProvider,
        ttsVoice: ttsVoice || null,
        systemPrompt: systemPrompt || null,
        avatarEnabled,
        visionEnabled,
        backgroundAudioEnabled,
        busyAudioEnabled,
        lettaAgentName: lettaAgentName || null,
        lettaLlmModel: lettaLlmModel || null,
        lettaSystemPrompt: lettaSystemPrompt || null,
      },
      {
        onSuccess: () => {
          deployMutation.mutate({ id: agentId });
        },
      },
    );
  };

  if (isLoading) {
    return <div className="flex items-center justify-center py-20 text-muted-foreground">Loading agent...</div>;
  }

  if (!agent) {
    return <div className="text-muted-foreground">Agent not found</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">{agent.name}</h2>
          {agent.description && <p className="text-sm text-muted-foreground">{agent.description}</p>}
        </div>
      </div>

      <Tabs defaultValue="livekit">
        <TabsList>
          <TabsTrigger value="livekit">LiveKit</TabsTrigger>
          <TabsTrigger value="letta">Letta</TabsTrigger>
          <TabsTrigger value="crews">Crews</TabsTrigger>
          <TabsTrigger value="deployment">Deployment</TabsTrigger>
          <TabsTrigger value="embed">Embed</TabsTrigger>
        </TabsList>

        <TabsContent value="livekit">
          <LiveKitSection
            sttProvider={sttProvider}
            setSttProvider={setSttProvider}
            sttModel={sttModel}
            setSttModel={setSttModel}
            llmProvider={llmProvider}
            setLlmProvider={setLlmProvider}
            llmModel={llmModel}
            setLlmModel={setLlmModel}
            ttsProvider={ttsProvider}
            setTtsProvider={setTtsProvider}
            ttsVoice={ttsVoice}
            setTtsVoice={setTtsVoice}
            systemPrompt={systemPrompt}
            setSystemPrompt={setSystemPrompt}
            avatarEnabled={avatarEnabled}
            setAvatarEnabled={setAvatarEnabled}
            avatarImageUrl={agent?.avatarImageUrl || ""}
            visionEnabled={visionEnabled}
            setVisionEnabled={setVisionEnabled}
            backgroundAudioEnabled={backgroundAudioEnabled}
            setBackgroundAudioEnabled={setBackgroundAudioEnabled}
            busyAudioEnabled={busyAudioEnabled}
            setBusyAudioEnabled={setBusyAudioEnabled}
            agentId={agentId}
          />
        </TabsContent>

        <TabsContent value="letta">
          <LettaSection
            agentId={agentId}
            appId={agent.appId}
            lettaAgentName={lettaAgentName}
            setLettaAgentName={setLettaAgentName}
            lettaLlmModel={lettaLlmModel}
            setLettaLlmModel={setLettaLlmModel}
            lettaSystemPrompt={lettaSystemPrompt}
            setLettaSystemPrompt={setLettaSystemPrompt}
          />
        </TabsContent>

        <TabsContent value="crews">
          <CrewBuilder agentId={agentId} appId={agent.appId} />
        </TabsContent>

        <TabsContent value="deployment">
          <DeploymentStatus agentId={agentId} agent={agent} />
        </TabsContent>

        <TabsContent value="embed">
          <EmbedSection
            agentId={agentId}
            appId={agent.appId}
            deployed={agent.deployed}
            avatarEnabled={agent.avatarEnabled}
          />
        </TabsContent>
      </Tabs>

      {/* Action bar */}
      <div className="flex items-center gap-2 border-t pt-4">
        <Button
          onClick={handleDeploy}
          disabled={updateMutation.isPending || deployMutation.isPending}
        >
          <Rocket className="h-4 w-4 mr-1" />
          {updateMutation.isPending
            ? "Saving..."
            : deployMutation.isPending
              ? "Deploying..."
              : "Deploy"}
        </Button>
        <div className="flex-1" />
        <Button
          variant="destructive"
          size="sm"
          onClick={() => {
            if (confirm(`Delete agent "${agent.name}"?`)) {
              deleteMutation.mutate({ id: agentId });
            }
          }}
        >
          <Trash2 className="h-4 w-4 mr-1" /> Delete
        </Button>
      </div>
    </div>
  );
}
