/**
 * Playground — connect to a LiveKit room with a deployed agent for E2E testing.
 *
 * Flow:
 * 1. Pick app + agent (members + admins only; RBAC enforced server-side).
 * 2. Click Connect → call playground.getConnectionBundle → server reads
 *    LiveKit creds from Vault, mints a JWT with RoomConfiguration.agents
 *    so the worker is auto-dispatched.
 * 3. Render <LiveKitRoom> + <VideoConference> for full audio/video/chat parity.
 */
import { useMemo, useState } from "react";
import { LiveKitRoom, VideoConference, useTranscriptions, useChat, RoomAudioRenderer } from "@livekit/components-react";
import "@livekit/components-styles";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { FlaskConical, AlertCircle, Loader2, LogOut } from "lucide-react";
import { toast } from "sonner";

interface Bundle {
  token: string;
  livekitUrl: string;
  roomName: string;
  identity: string;
  displayName: string;
  expiresAt: string;
  agent: { id: number; name: string; visionEnabled: boolean; avatarEnabled: boolean };
}

/**
 * Live transcription side panel — uses the @livekit/components-react
 * useTranscriptions() hook to surface STT events from the agent worker.
 *
 * Server-side STT runs on the agent worker and publishes transcription
 * events as text streams over the room (one stream per utterance, with
 * incremental updates). The user-side UI must subscribe to these via
 * useTranscriptions() to display them — the VideoConference prefab on
 * its own renders chat messages but NOT transcription events.
 */
function TranscriptionPanel() {
  // Two independent streams need to be rendered side-by-side:
  //  1. Voice transcriptions (lk.transcription topic) — streaming STT text
  //     from both the user and the primary voice agent.
  //  2. Chat messages (lk.chat topic) — discrete messages, including the
  //     secondary Letta agent's structured output that the voice agent
  //     publishes via send_text(..., topic='lk.chat') from inside its
  //     delegate_to_letta tool.
  const transcriptions = useTranscriptions();
  const { chatMessages } = useChat();

  return (
    <aside className="w-80 border-l bg-card overflow-y-auto p-3 text-sm flex flex-col gap-4">
      <section>
        <div className="font-semibold text-xs uppercase text-muted-foreground tracking-wide mb-2">
          Live Transcription
        </div>
        {transcriptions.length === 0 ? (
          <p className="text-muted-foreground text-xs italic">
            Speak to see transcriptions appear here.
          </p>
        ) : (
          <div className="space-y-2">
            {transcriptions.map((t, i) => (
              <div key={i} className="border-b pb-2 last:border-b-0">
                <div className="text-[10px] uppercase text-muted-foreground tracking-wide">
                  {t.participantInfo?.identity ?? "unknown"}
                </div>
                <div className="text-sm whitespace-pre-wrap">{t.text}</div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="font-semibold text-xs uppercase text-muted-foreground tracking-wide mb-2">
          Secondary Agent Output
        </div>
        {chatMessages.length === 0 ? (
          <p className="text-muted-foreground text-xs italic">
            Letta-delegated results will appear here.
          </p>
        ) : (
          <div className="space-y-2">
            {chatMessages.map((m, i) => (
              <div key={i} className="border-b pb-2 last:border-b-0">
                <div className="text-[10px] uppercase text-muted-foreground tracking-wide">
                  {m.from?.identity ?? "agent"}
                </div>
                <div className="text-sm whitespace-pre-wrap">{m.message}</div>
              </div>
            ))}
          </div>
        )}
      </section>
    </aside>
  );
}

export default function Playground() {
  const [appId, setAppId] = useState<number | null>(null);
  const [agentId, setAgentId] = useState<number | null>(null);
  const [bundle, setBundle] = useState<Bundle | null>(null);

  const { data: apps, isLoading: appsLoading } = trpc.appsCrud.list.useQuery();
  const { data: agents, isLoading: agentsLoading } = trpc.agentsCrud.list.useQuery(
    { appId: appId ?? 0 },
    { enabled: appId !== null },
  );
  const { data: meta } = trpc.playground.getMeta.useQuery(
    { appId: appId ?? 0 },
    { enabled: appId !== null },
  );

  const connect = trpc.playground.getConnectionBundle.useMutation({
    onSuccess: (b) => {
      setBundle(b as Bundle);
      toast.success(`Connected to room ${(b as Bundle).roomName}`);
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const selectedAgent = useMemo(
    () => (agents as any[] | undefined)?.find((a) => a.id === agentId) ?? null,
    [agents, agentId],
  );

  const canConnect =
    appId !== null &&
    agentId !== null &&
    selectedAgent?.deployed === true &&
    meta?.livekitReady === true &&
    !connect.isPending;

  function handleDisconnect() {
    setBundle(null);
  }

  // ── Connected state: full LiveKit room ────────────────────────────
  if (bundle) {
    return (
      <div className="flex flex-col h-[calc(100vh-3rem)] -m-6">
        <div className="flex items-center justify-between border-b bg-card px-4 py-2">
          <div className="flex items-center gap-2 text-sm">
            <FlaskConical className="h-4 w-4" />
            <span className="font-medium">Playground</span>
            <span className="text-muted-foreground">·</span>
            <span>{bundle.agent.name}</span>
            <span className="text-muted-foreground">·</span>
            <span className="font-mono text-xs text-muted-foreground">{bundle.roomName}</span>
          </div>
          <Button size="sm" variant="outline" onClick={handleDisconnect}>
            <LogOut className="h-3 w-3 mr-1" /> Disconnect
          </Button>
        </div>
        <div className="flex-1 min-h-0">
          <LiveKitRoom
            token={bundle.token}
            serverUrl={bundle.livekitUrl}
            connect={true}
            audio={true}
            video={bundle.agent.visionEnabled}
            data-lk-theme="default"
            style={{ height: "100%" }}
            onDisconnected={handleDisconnect}
          >
            {/* RoomAudioRenderer is required to actually play remote audio
                tracks (the agent's TTS output). VideoConference includes it
                internally, but mounting it explicitly is defensive. */}
            <RoomAudioRenderer />
            <div className="flex h-full">
              <div className="flex-1 min-w-0">
                <VideoConference />
              </div>
              <TranscriptionPanel />
            </div>
          </LiveKitRoom>
        </div>
      </div>
    );
  }

  // ── Selection state ──────────────────────────────────────────────
  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <FlaskConical className="h-7 w-7" /> Playground
        </h1>
        <p className="text-muted-foreground mt-1">
          Connect to a deployed agent in a fresh LiveKit room. Each session is isolated per
          (agent, user, room) so concurrent testers don't collide.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Connect to an agent</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="app-select">App</Label>
            <select
              id="app-select"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={appId ?? ""}
              onChange={(e) => {
                const v = e.target.value ? Number(e.target.value) : null;
                setAppId(v);
                setAgentId(null);
              }}
              disabled={appsLoading}
            >
              <option value="">— Select an app —</option>
              {(apps as any[] | undefined)?.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.slug})
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="agent-select">Agent</Label>
            <select
              id="agent-select"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={agentId ?? ""}
              onChange={(e) => setAgentId(e.target.value ? Number(e.target.value) : null)}
              disabled={appId === null || agentsLoading}
            >
              <option value="">
                {appId === null ? "— Select an app first —" : "— Select an agent —"}
              </option>
              {(agents as any[] | undefined)?.map((a) => (
                <option key={a.id} value={a.id} disabled={!a.deployed}>
                  {a.name} {a.deployed ? "" : "(not deployed)"}
                </option>
              ))}
            </select>
          </div>

          {appId !== null && meta && !meta.livekitReady && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm">
              <AlertCircle className="h-4 w-4 mt-0.5 text-destructive" />
              <div>
                <p className="font-medium text-destructive">LiveKit not provisioned</p>
                <p className="text-muted-foreground">
                  This app is missing LiveKit credentials in Vault. Re-run provisioning from the
                  Apps page.
                </p>
              </div>
            </div>
          )}

          {selectedAgent && !selectedAgent.deployed && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
              <AlertCircle className="h-4 w-4 mt-0.5 text-amber-600" />
              <div>
                <p className="font-medium">Agent not deployed</p>
                <p className="text-muted-foreground">
                  Deploy this agent from the Agent Builder before testing in Playground.
                </p>
              </div>
            </div>
          )}

          <Button
            onClick={() =>
              appId !== null && agentId !== null && connect.mutate({ appId, agentId })
            }
            disabled={!canConnect}
            className="w-full"
          >
            {connect.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Connecting…
              </>
            ) : (
              "Connect"
            )}
          </Button>

          {meta?.langfuseProjectId && (
            <p className="text-xs text-muted-foreground">
              Langfuse project: <code>{meta.langfuseProjectId}</code>
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
