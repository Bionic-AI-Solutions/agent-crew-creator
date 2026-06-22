import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Copy,
  Plus,
  Trash2,
  Ban,
  Code2,
  Mic,
  MessageSquare,
  Camera,
  MonitorUp,
  User,
  Eye,
  AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";

interface Props {
  agentId: number;
  appId: number;
  deployed: boolean;
  avatarEnabled: boolean;
}

export default function EmbedSection({ agentId, appId, deployed, avatarEnabled }: Props) {
  const utils = trpc.useUtils();
  const { data: tokens, isLoading } = trpc.embed.listByAgent.useQuery({ agentId });

  const createMutation = trpc.embed.create.useMutation({
    onSuccess: () => {
      toast.success("Embed token created");
      utils.embed.listByAgent.invalidate({ agentId });
      setShowCreate(false);
    },
    onError: (err) => toast.error(err.message),
  });

  const revokeMutation = trpc.embed.revoke.useMutation({
    onSuccess: () => {
      toast.success("Token revoked");
      utils.embed.listByAgent.invalidate({ agentId });
    },
    onError: (err) => toast.error(err.message),
  });

  const deleteMutation = trpc.embed.delete.useMutation({
    onSuccess: () => {
      toast.success("Token deleted");
      utils.embed.listByAgent.invalidate({ agentId });
    },
    onError: (err) => toast.error(err.message),
  });

  const [showCreate, setShowCreate] = useState(false);
  const [newLabel, setNewLabel] = useState("default");
  const [newMode, setNewMode] = useState<"popup" | "iframe">("popup");
  const [newTheme, setNewTheme] = useState<"light" | "dark">("light");
  const [newVoice, setNewVoice] = useState(true);
  const [newChat, setNewChat] = useState(true);
  const [newTranscription, setNewTranscription] = useState(true);
  const [newVideo, setNewVideo] = useState(false);
  const [newScreenShare, setNewScreenShare] = useState(false);
  const [newAvatar, setNewAvatar] = useState(avatarEnabled);
  const [newOrigins, setNewOrigins] = useState("");
  const [expandedToken, setExpandedToken] = useState<number | null>(null);

  // Derive platform origin for snippet display
  const platformOrigin = typeof window !== "undefined" ? window.location.origin : "https://platform.baisoln.com";

  if (!deployed) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="flex items-center gap-3 text-amber-600">
            <AlertTriangle className="h-5 w-5" />
            <p>Deploy this agent before creating embed tokens.</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const handleCreate = () => {
    const origins = newOrigins
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    createMutation.mutate({
      agentConfigId: agentId,
      label: newLabel || "default",
      mode: newMode,
      theme: newTheme,
      allowVoice: newVoice,
      allowChat: newChat,
      showTranscription: newTranscription,
      allowVideo: newVideo,
      allowScreenShare: newScreenShare,
      allowAvatar: newAvatar,
      allowedOrigins: origins,
    });
  };

  const getSnippet = (token: { token: string; mode: string }) => {
    if (token.mode === "iframe") {
      return `<iframe
  src="${platformOrigin}/embed/${token.token}"
  width="400" height="600"
  allow="microphone; camera; display-capture"
  style="border: none; border-radius: 16px;"
></iframe>`;
    }
    return `<script
  src="${platformOrigin}/api/embed/widget.js"
  data-bionic-embed-token="${token.token}"
  defer
></script>`;
  };

  const copySnippet = (token: { token: string; mode: string }) => {
    navigator.clipboard.writeText(getSnippet(token));
    toast.success("Snippet copied to clipboard");
  };

  const featureIcons = (t: {
    allowVoice: boolean;
    allowChat: boolean;
    allowVideo: boolean;
    allowScreenShare: boolean;
    allowAvatar: boolean;
  }) => (
    <div className="flex gap-1">
      {t.allowVoice && <span title="Voice"><Mic className="h-3.5 w-3.5 text-muted-foreground" /></span>}
      {t.allowChat && <span title="Chat"><MessageSquare className="h-3.5 w-3.5 text-muted-foreground" /></span>}
      {t.allowVideo && <span title="Camera"><Camera className="h-3.5 w-3.5 text-muted-foreground" /></span>}
      {t.allowScreenShare && <span title="Screen Share"><MonitorUp className="h-3.5 w-3.5 text-muted-foreground" /></span>}
      {t.allowAvatar && <span title="Avatar"><User className="h-3.5 w-3.5 text-muted-foreground" /></span>}
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Create token section */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-base font-medium">Embed Tokens</CardTitle>
          <Button size="sm" variant="outline" onClick={() => setShowCreate(!showCreate)}>
            <Plus className="mr-1 h-4 w-4" />
            New Token
          </Button>
        </CardHeader>

        {showCreate && (
          <CardContent className="border-t pt-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label>Label</Label>
                <Input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="e.g. website-main" />
              </div>
              <div>
                <Label>Mode</Label>
                <div className="flex gap-2 mt-1">
                  <Button size="sm" variant={newMode === "popup" ? "default" : "outline"} onClick={() => setNewMode("popup")}>Popup</Button>
                  <Button size="sm" variant={newMode === "iframe" ? "default" : "outline"} onClick={() => setNewMode("iframe")}>iFrame</Button>
                </div>
              </div>
              <div>
                <Label>Theme</Label>
                <div className="flex gap-2 mt-1">
                  <Button size="sm" variant={newTheme === "light" ? "default" : "outline"} onClick={() => setNewTheme("light")}>Light</Button>
                  <Button size="sm" variant={newTheme === "dark" ? "default" : "outline"} onClick={() => setNewTheme("dark")}>Dark</Button>
                </div>
              </div>
              <div>
                <Label>Features</Label>
                <div className="flex flex-wrap gap-2 mt-1">
                  <ToggleChip label="Voice" active={newVoice} onChange={setNewVoice} />
                  <ToggleChip label="Chat" active={newChat} onChange={setNewChat} />
                  {newChat && <ToggleChip label="Transcription" active={newTranscription} onChange={setNewTranscription} />}
                  <ToggleChip label="Camera" active={newVideo} onChange={setNewVideo} />
                  <ToggleChip label="Screen Share" active={newScreenShare} onChange={setNewScreenShare} />
                  {avatarEnabled && <ToggleChip label="Avatar" active={newAvatar} onChange={setNewAvatar} />}
                </div>
              </div>

              {(newVideo || newScreenShare) && (
                <div className="sm:col-span-2 text-xs text-amber-600 flex items-start gap-1">
                  <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  Enabling camera or screen share allows website visitors to share media with the agent. Captured frames may be stored per your agent's capture settings.
                </div>
              )}

              <div className="sm:col-span-2">
                <Label>Allowed Origins</Label>
                <Input
                  value={newOrigins}
                  onChange={(e) => setNewOrigins(e.target.value)}
                  placeholder="https://example.com, https://mysite.com (empty = all origins)"
                />
                {!newOrigins.trim() && (
                  <p className="text-xs text-amber-600 mt-1 flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" />
                    Empty = any website can use this token
                  </p>
                )}
              </div>

              <div className="sm:col-span-2">
                <Button onClick={handleCreate} disabled={createMutation.isPending}>
                  {createMutation.isPending ? "Creating..." : "Create Token"}
                </Button>
              </div>
            </div>
          </CardContent>
        )}
      </Card>

      {/* Token list */}
      {isLoading && <p className="text-sm text-muted-foreground">Loading tokens...</p>}
      {tokens && tokens.length === 0 && !showCreate && (
        <p className="text-sm text-muted-foreground">No embed tokens yet. Create one to get started.</p>
      )}

      {tokens?.map((t) => (
        <Card key={t.id} className={!t.isActive ? "opacity-60" : ""}>
          <CardContent className="py-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Code2 className="h-4 w-4 text-muted-foreground" />
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{t.label}</span>
                    <Badge variant="outline" className="text-xs">{t.mode}</Badge>
                    <Badge variant="outline" className="text-xs">{t.theme}</Badge>
                    {!t.isActive && <Badge variant="destructive" className="text-xs">Revoked</Badge>}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    {featureIcons(t)}
                    {t.lastUsedAt && (
                      <span className="text-xs text-muted-foreground">
                        Last used: {new Date(t.lastUsedAt).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-1">
                {t.isActive && (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => copySnippet(t)}
                      title="Copy embed snippet"
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setExpandedToken(expandedToken === t.id ? null : t.id)}
                      title="View snippet"
                    >
                      <Eye className="h-4 w-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => revokeMutation.mutate({ id: t.id })}
                      title="Revoke token"
                    >
                      <Ban className="h-4 w-4" />
                    </Button>
                  </>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  onClick={() => deleteMutation.mutate({ id: t.id })}
                  title="Delete token"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Expanded snippet view */}
            {expandedToken === t.id && t.isActive && (
              <div className="mt-3 border-t pt-3">
                <div className="flex items-center justify-between mb-1">
                  <Label className="text-xs text-muted-foreground">Embed Snippet</Label>
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => copySnippet(t)}>
                    <Copy className="mr-1 h-3 w-3" /> Copy
                  </Button>
                </div>
                <pre className="bg-muted p-3 rounded-md text-xs overflow-x-auto whitespace-pre-wrap">
                  {getSnippet(t)}
                </pre>
                <p className="text-xs text-muted-foreground mt-2">
                  If your site uses Content-Security-Policy, add{" "}
                  <code className="bg-muted px-1 rounded">
                    {t.mode === "popup" ? `script-src ${platformOrigin}` : `frame-src ${platformOrigin}`}
                  </code>{" "}
                  to your CSP header.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/** Small toggle chip for feature selection. */
function ToggleChip({
  label,
  active,
  onChange,
}: {
  label: string;
  active: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!active)}
      className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
        active
          ? "bg-primary text-primary-foreground border-primary"
          : "bg-background text-muted-foreground border-border hover:bg-muted"
      }`}
    >
      {label}
    </button>
  );
}
