import { useMemo } from "react";
import { Copy, ExternalLink, KeyRound, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";

interface Props {
  appId: number;
  agentId: number;
  agent: {
    name: string;
    deployed: boolean;
  };
}

interface DemoBundle {
  token: string;
  livekitUrl: string;
  roomName: string;
  identity: string;
  expiresAt: string;
}

function copyToClipboard(label: string, value?: string) {
  if (!value) return;
  navigator.clipboard
    .writeText(value)
    .then(() => toast.success(`${label} copied`))
    .catch(() => toast.error(`Could not copy ${label.toLowerCase()}`));
}

export default function EmbedSection({ appId, agentId, agent }: Props) {
  const tokenMutation = trpc.playground.getConnectionBundle.useMutation();
  const bundle = tokenMutation.data as DemoBundle | undefined;

  const meetUrl = useMemo(() => {
    if (!bundle?.livekitUrl || !bundle.token) return "https://meet.livekit.io/";
    // LiveKit Meet expects `liveKitUrl` specifically, and the WSS URL must
    // remain unencoded for its custom join flow.
    return `https://meet.livekit.io/custom?liveKitUrl=${bundle.livekitUrl}&token=${bundle.token}`;
  }, [bundle]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-5 w-5" />
          Demo Embed Token
        </CardTitle>
        <CardDescription>
          Generate a fresh LiveKit token for this deployed agent. The token uses the same room dispatch
          path as Playground, so joining with it should auto-connect the agent worker.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!agent.deployed && (
          <div className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
            Deploy this agent before generating a demo token.
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            onClick={() => tokenMutation.mutate({ appId, agentId })}
            disabled={!agent.deployed || tokenMutation.isPending}
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${tokenMutation.isPending ? "animate-spin" : ""}`} />
            {tokenMutation.isPending ? "Generating..." : "Generate fresh token"}
          </Button>
          {bundle && (
            <Button type="button" variant="outline" asChild>
              <a href={meetUrl} target="_blank" rel="noreferrer">
                <ExternalLink className="mr-2 h-4 w-4" />
                Open meet.livekit.io
              </a>
            </Button>
          )}
        </div>

        {tokenMutation.error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {tokenMutation.error.message}
          </div>
        )}

        {bundle ? (
          <div className="space-y-4">
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-2">
                <Label>LiveKit URL</Label>
                <div className="flex gap-2">
                  <Input readOnly value={bundle.livekitUrl} className="font-mono text-xs" />
                  <Button type="button" variant="outline" size="sm" onClick={() => copyToClipboard("LiveKit URL", bundle.livekitUrl)}>
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="space-y-2">
                <Label>Room</Label>
                <Input readOnly value={bundle.roomName} className="font-mono text-xs" />
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-2">
                <Label>Agent</Label>
                <Input readOnly value={agent.name} className="font-mono text-xs" />
              </div>
              <div className="space-y-2">
                <Label>Expires</Label>
                <Input readOnly value={new Date(bundle.expiresAt).toLocaleString()} className="text-xs" />
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label>Token</Label>
                <Button type="button" variant="outline" size="sm" onClick={() => copyToClipboard("Token", bundle.token)}>
                  <Copy className="mr-2 h-4 w-4" />
                  Copy token
                </Button>
              </div>
              <Textarea readOnly value={bundle.token} className="min-h-32 font-mono text-xs" />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label>meet.livekit.io link</Label>
                <Button type="button" variant="outline" size="sm" onClick={() => copyToClipboard("Meet link", meetUrl)}>
                  <Copy className="mr-2 h-4 w-4" />
                  Copy link
                </Button>
              </div>
              <Input readOnly value={meetUrl} className="font-mono text-xs" />
              <p className="text-xs text-muted-foreground">
                If the link does not auto-fill the demo page, paste the LiveKit URL and token above into
                meet.livekit.io manually.
              </p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No token generated yet. Tokens are short-lived and generated only on demand for the selected
            deployed agent.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
