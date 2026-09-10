import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { shouldReseedForm } from "@/lib/formReseed";
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

/** Mirrors MAX_DENYLIST_TERM_CHARS in server/agentRouter.ts. */
const MAX_DENYLIST_TERM_CHARS = 60;

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
  const [ttsLanguage, setTtsLanguage] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [avatarEnabled, setAvatarEnabled] = useState(false);
  const [avatarProvider, setAvatarProvider] = useState("flashhead");
  const [avatarReferenceImage, setAvatarReferenceImage] = useState("");
  const [avatarName, setAvatarName] = useState("");
  const [visionEnabled, setVisionEnabled] = useState(false);
  const [domReadEnabled, setDomReadEnabled] = useState(false);
  const [domControlEnabled, setDomControlEnabled] = useState(false);
  // Held as the raw comma-separated string the operator typed, so a trailing
  // comma mid-edit does not make entries appear and vanish under the cursor.
  const [domActionDenylist, setDomActionDenylist] = useState("");
  const [backgroundAudioEnabled, setBackgroundAudioEnabled] = useState(false);
  const [busyAudioEnabled, setBusyAudioEnabled] = useState(false);
  const [lettaAgentName, setLettaAgentName] = useState("");
  const [lettaLlmModel, setLettaLlmModel] = useState("");
  const [lettaSystemPrompt, setLettaSystemPrompt] = useState("");

  // Seed form state ONLY when a new agent loads (identity change), not on every
  // background refetch of the same agent — otherwise a sibling panel
  // invalidating getById would clobber the user's unsaved edits.
  const seededIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (agent && shouldReseedForm(seededIdRef.current, agent.id)) {
      seededIdRef.current = agent.id;
      setSttProvider(agent.sttProvider);
      setSttModel(agent.sttModel || "");
      setLlmProvider(agent.llmProvider);
      setLlmModel(agent.llmModel || "");
      setTtsProvider(agent.ttsProvider);
      setTtsVoice(agent.ttsVoice || "");
      setTtsLanguage((agent as any).ttsLanguage || "en-IN");
      setSystemPrompt(agent.systemPrompt || "");
      setAvatarEnabled(Boolean(agent.avatarEnabled));
      setAvatarProvider((agent as any).avatarProvider || "flashhead");
      setAvatarReferenceImage((agent as any).avatarReferenceImage || "");
      setAvatarName((agent as any).avatarName || "");
      setVisionEnabled(agent.visionEnabled);
      setDomReadEnabled(Boolean((agent as any).domReadEnabled));
      setDomControlEnabled(Boolean((agent as any).domControlEnabled));
      setDomActionDenylist(((agent as any).domActionDenylist ?? []).join(", "));
      setBackgroundAudioEnabled(agent.backgroundAudioEnabled);
      setBusyAudioEnabled((agent as any).busyAudioEnabled ?? false);
      setLettaAgentName(agent.lettaAgentName || "");
      setLettaLlmModel(agent.lettaLlmModel || "");
      setLettaSystemPrompt(agent.lettaSystemPrompt || "");
    }
  }, [agent]);

  const updateMutation = trpc.agentsCrud.update.useMutation({
    onSuccess: () => {
      toast.success(
        denylistWasTrimmed
          ? "Agent saved — denylist terms were tidied to what is enforced"
          : "Agent saved",
      );
      setDomActionDenylist(denylistTerms.join(", "));
      utils.agentsCrud.getById.invalidate({ id: agentId });
    },
    onError: (err) => toast.error(err.message),
  });

  const deployMutation = trpc.agentsCrud.deploy.useMutation({
    onSuccess: () => {
      toast.success("Deployment started");
      utils.agentsCrud.getById.invalidate({ id: agentId });
      utils.agentsCrud.getDeploymentStatus.invalidate({ id: agentId });
      utils.agentsCrud.list.invalidate();
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

  // Parsed once, and the field is rewritten from the result on save.
  //
  // The server truncates a term over 60 characters rather than refusing it,
  // so without echoing that back the operator kept seeing their original text
  // above an "Agent saved" toast while a shorter term was what actually got
  // enforced. For a field whose entire job is to block dangerous actions,
  // believing a phrase is protecting something when only its first 60
  // characters are is the wrong thing to be wrong about.
  const denylistTerms = [
    // De-duplicated here as well as on the server. Without it the echo put
    // back what the operator typed rather than what was stored, so "delete,
    // delete" stayed on screen while one entry was saved -- and the field
    // then shrank without explanation the next time the form loaded, looking
    // like data loss.
    ...new Set(
      domActionDenylist
        .split(",")
        .map((s) => s.trim().toLowerCase().slice(0, MAX_DENYLIST_TERM_CHARS))
        .filter(Boolean),
    ),
  ];
  const denylistWasTrimmed = denylistTerms.join(", ") !== domActionDenylist.trim();

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
        ttsLanguage: ttsLanguage || null,
        systemPrompt: systemPrompt || null,
        avatarEnabled,
        avatarProvider: avatarProvider || "flashhead",
        avatarReferenceImage: avatarReferenceImage || null,
        avatarName: avatarName || null,
        visionEnabled,
        domReadEnabled,
        // Never persist a combination the server would reject anyway.
        domControlEnabled: domControlEnabled && domReadEnabled,
        domActionDenylist: denylistTerms,
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
            ttsLanguage={ttsLanguage}
            setTtsLanguage={setTtsLanguage}
            systemPrompt={systemPrompt}
            setSystemPrompt={setSystemPrompt}
            avatarEnabled={avatarEnabled}
            setAvatarEnabled={setAvatarEnabled}
            avatarProvider={avatarProvider}
            setAvatarProvider={setAvatarProvider}
            avatarReferenceImage={avatarReferenceImage}
            setAvatarReferenceImage={setAvatarReferenceImage}
            avatarName={avatarName}
            setAvatarName={setAvatarName}
            avatarImageUrl={(agent as any)?.avatarImageUrl || ""}
            visionEnabled={visionEnabled}
            setVisionEnabled={setVisionEnabled}
            domReadEnabled={domReadEnabled}
            setDomReadEnabled={setDomReadEnabled}
            domControlEnabled={domControlEnabled}
            setDomControlEnabled={setDomControlEnabled}
            domActionDenylist={domActionDenylist}
            setDomActionDenylist={setDomActionDenylist}
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
