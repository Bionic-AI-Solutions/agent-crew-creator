/**
 * Playground — connect to a LiveKit room with a deployed agent for E2E testing.
 *
 * Flow:
 * 1. Pick app + agent (members + admins only; RBAC enforced server-side).
 * 2. Click Connect → call playground.getConnectionBundle → server reads
 *    LiveKit creds from Vault, mints a JWT with RoomConfiguration.agents
 *    so the worker is auto-dispatched.
 * 3. Render an agent-focused LiveKit room UI with voice controls,
 *    audio visualization, transcript, and delegated output.
 */
import { useMemo, useState } from "react";
import {
  BarVisualizer,
  DisconnectButton,
  LiveKitRoom,
  RoomAudioRenderer,
  StartAudio,
  TrackToggle,
  useChat,
  useConnectionState,
  useTranscriptions,
  useVoiceAssistant,
  VideoTrack,
} from "@livekit/components-react";
import "@livekit/components-styles";
import { ConnectionState, Track } from "livekit-client";
import { marked } from "marked";
import { trpc } from "@/lib/trpc";
import { rewriteS3UrlsInHtml, toBrowserS3ProxyUrl } from "@/lib/s3ProxyUrl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { FlaskConical, AlertCircle, Loader2, Mic, PhoneOff, Video } from "lucide-react";
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
function AgentTranscriptPanel() {
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
    <aside className="w-full border-l bg-card overflow-y-auto p-4 text-sm flex flex-col gap-4 lg:w-[26rem]">
      <section>
        <div className="font-semibold text-xs uppercase text-muted-foreground tracking-wide mb-2">
          Live Transcript
        </div>
        {transcriptions.length === 0 ? (
          <p className="text-muted-foreground text-xs italic">
            Spoken conversation will appear here as transcription events arrive.
          </p>
        ) : (
          <div className="space-y-2">
            {transcriptions.slice(-30).map((t: any, i: number) => (
              <div key={`${t.id || i}-${t.final ? "final" : "partial"}`} className="rounded-md border bg-background/60 p-2">
                <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {t.participant?.identity || t.participantIdentity || "speaker"}
                  {!t.final && <span className="ml-1 italic">(speaking)</span>}
                </div>
                <p className={t.final ? "" : "text-muted-foreground"}>{t.text}</p>
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
          <div className="space-y-3">
            {chatMessages.map((m, i) => (
              <div key={i} className="border-b pb-3 last:border-b-0">
                <div className="text-[10px] uppercase text-muted-foreground tracking-wide mb-1">
                  {m.from?.identity ?? "agent"}
                </div>
                <SecondaryAgentMessage message={m.message} />
              </div>
            ))}
          </div>
        )}
      </section>
    </aside>
  );
}

function AgentSessionSurface({ bundle, onDisconnect }: { bundle: Bundle; onDisconnect: () => void }) {
  const voice = useVoiceAssistant();
  const connectionState = useConnectionState();
  const connected = connectionState === ConnectionState.Connected;
  const agentState = String(voice.state || "initializing").replace(/_/g, " ");

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center justify-between border-b bg-card px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm">
            <FlaskConical className="h-4 w-4" />
            <span className="font-medium">Playground</span>
            <span className="text-muted-foreground">/</span>
            <span>{bundle.agent.name}</span>
          </div>
          <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
            {bundle.roomName}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full border px-2 py-1 text-xs capitalize text-muted-foreground">
            {connected ? agentState : connectionState}
          </span>
          <DisconnectButton
            className="inline-flex h-9 items-center rounded-md border px-3 text-sm hover:bg-muted"
            onClick={onDisconnect}
          >
            <PhoneOff className="mr-1 h-3.5 w-3.5" /> End
          </DisconnectButton>
        </div>
      </div>

      <div className="grid flex-1 min-h-0 grid-cols-1 lg:grid-cols-[1fr_26rem]">
        <main className="flex min-h-0 flex-col items-center justify-center gap-6 p-6">
          <div className="relative flex aspect-square w-full max-w-[28rem] items-center justify-center overflow-hidden rounded-3xl border bg-card shadow-sm">
            {bundle.agent.avatarEnabled && voice.videoTrack ? (
              <VideoTrack trackRef={voice.videoTrack} className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-5 bg-gradient-to-br from-background via-muted/50 to-background p-8">
                <div className="flex h-28 w-28 items-center justify-center rounded-full border bg-background shadow-inner">
                  <FlaskConical className="h-12 w-12 text-muted-foreground" />
                </div>
                <div className="text-center">
                  <div className="text-xl font-semibold">{bundle.agent.name}</div>
                  <div className="mt-1 text-sm capitalize text-muted-foreground">{agentState}</div>
                </div>
              </div>
            )}
          </div>

          <div className="w-full max-w-xl rounded-2xl border bg-card p-5">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <div className="text-sm font-medium">Agent audio</div>
                <div className="text-xs capitalize text-muted-foreground">{agentState}</div>
              </div>
              <StartAudio
                label="Enable audio"
                className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted"
              />
            </div>
            <BarVisualizer
              state={voice.state}
              trackRef={voice.audioTrack}
              barCount={7}
              className="mx-auto flex h-20 items-center justify-center gap-2"
            >
              <span className="block w-2 rounded-full bg-primary/80 data-[lk-highlighted=true]:bg-primary" />
            </BarVisualizer>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-2">
            <TrackToggle
              source={Track.Source.Microphone}
              className="inline-flex h-10 items-center rounded-md border px-4 text-sm hover:bg-muted data-[lk-enabled=true]:bg-primary data-[lk-enabled=true]:text-primary-foreground"
            >
              <Mic className="mr-2 h-4 w-4" /> Microphone
            </TrackToggle>
            {bundle.agent.visionEnabled && (
              <TrackToggle
                source={Track.Source.Camera}
                className="inline-flex h-10 items-center rounded-md border px-4 text-sm hover:bg-muted data-[lk-enabled=true]:bg-primary data-[lk-enabled=true]:text-primary-foreground"
              >
                <Video className="mr-2 h-4 w-4" /> Camera
              </TrackToggle>
            )}
          </div>
        </main>

        <AgentTranscriptPanel />
      </div>
    </div>
  );
}

/**
 * Renders a Letta secondary-agent message. The message is a mix of plain
 * markdown text and embedded JSON artifact blocks (one per line) of the form:
 *   {"type":"artifact","subtype":"image","title":"...","image_url":"https://..."}
 *
 * We scan each line; if it parses to an artifact JSON, render it as a card
 * (image for subtype=image, download link otherwise). Non-JSON text is
 * rendered as markdown.
 */

function SecondaryAgentMessage({ message }: { message: string }) {
  interface Artifact {
    type: "artifact";
    subtype?: "image" | "file" | string;
    title?: string;
    image_url?: string;
    download_url?: string;
    url?: string;
    content_type?: string;
    summary?: string;
    internal_s3_url?: string;
  }

  // Split message into segments — plain text and artifact JSON objects.
  // Artifacts are separated by blank lines in _parse_letta_response output.
  const segments: Array<{ kind: "text"; value: string } | { kind: "artifact"; value: Artifact }> = [];
  const blocks = message.split(/\n\n+/);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed) as Artifact;
        if (parsed && parsed.type === "artifact") {
          segments.push({ kind: "artifact", value: parsed });
          continue;
        }
      } catch {
        // fall through — treat as text
      }
    }
    segments.push({ kind: "text", value: trimmed });
  }

  return (
    <div className="space-y-2">
      {segments.map((seg, idx) => {
        if (seg.kind === "artifact") {
          const a = seg.value;
          const rawUrl = a.image_url || a.url || a.download_url || "";
          const imageUrl = rawUrl ? toBrowserS3ProxyUrl(rawUrl) : "";
          const isImage =
            a.subtype === "image" ||
            (a.content_type ?? "").startsWith("image/") ||
            /\.(png|jpg|jpeg|gif|webp|svg)(\?|$)/i.test(imageUrl);
          if (isImage && imageUrl) {
            // Same-origin /api/s3-proxy or public https — not raw s3 (PNA) or internal K8s DNS
            const isAccessible =
              imageUrl.startsWith("/api/s3-proxy") ||
              ((imageUrl.startsWith("http://") || imageUrl.startsWith("https://")) &&
                !imageUrl.includes(".svc.cluster.local"));
            return (
              <figure key={idx} className="rounded border bg-background overflow-hidden">
                {isAccessible ? (
                  <img
                    src={imageUrl}
                    alt={a.title || "Generated image"}
                    className="w-full h-auto block"
                    loading="lazy"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                  />
                ) : (
                  <div className="px-2 py-3 text-xs text-muted-foreground italic text-center">
                    Image generated (not viewable in browser)
                  </div>
                )}
                {a.title && (
                  <figcaption className="px-2 py-1 text-[11px] text-muted-foreground italic">
                    {a.title}
                  </figcaption>
                )}
              </figure>
            );
          }
          // Non-image artifact — render as a download card
          return (
            <a
              key={idx}
              href={imageUrl || "#"}
              target="_blank"
              rel="noopener noreferrer"
              className="block rounded border bg-background px-2 py-1.5 text-xs hover:bg-muted"
            >
              <div className="font-medium">{a.title || "Artifact"}</div>
              {a.summary && <div className="text-muted-foreground">{a.summary}</div>}
              {a.content_type && (
                <div className="text-[10px] text-muted-foreground">{a.content_type}</div>
              )}
            </a>
          );
        }
        // Plain text segment — render as markdown for rich formatting.
        return (
          <div
            key={idx}
            className="text-sm prose prose-sm dark:prose-invert max-w-none"
            dangerouslySetInnerHTML={{
              __html: (() => {
                try {
                  const raw = marked.parse(seg.value, { breaks: true, gfm: true }) as string;
                  return rewriteS3UrlsInHtml(raw);
                } catch {
                  return seg.value;
                }
              })(),
            }}
          />
        );
      })}
    </div>
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

  // ── Connected state: agent-focused LiveKit room ───────────────────
  if (bundle) {
    return (
      <div className="flex flex-col h-[calc(100vh-3rem)] -m-6">
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
            <RoomAudioRenderer />
            <AgentSessionSurface bundle={bundle} onDisconnect={handleDisconnect} />
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
