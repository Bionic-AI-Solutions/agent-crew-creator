import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { slugify } from "@/lib/utils";

interface Props {
  onComplete: () => void;
  onCancel: () => void;
}

const SERVICES = [
  { key: "livekit", label: "LiveKit", description: "API key/secret for voice/video", required: true },
  { key: "keycloak", label: "Keycloak", description: "OIDC clients for authentication" },
  { key: "langfuse", label: "Langfuse", description: "Observability & tracing" },
  { key: "kubernetes", label: "Kubernetes", description: "Namespace + RBAC + quota" },
  { key: "postgres", label: "PostgreSQL", description: "Dedicated database" },
  { key: "redis", label: "Redis", description: "Cache & sessions" },
  { key: "minio", label: "MinIO", description: "Object storage bucket" },
  { key: "letta", label: "Letta", description: "Memory tenant for agents" },
  {
    key: "player_ui",
    label: "Agent player UI",
    description:
      "Per app: generates UI build context (app metadata JSON), docker build+push to PLAYER_UI_IMAGE_REPOSITORY:{slug}, deploys to namespace; or PLAYER_UI_IMAGE for pre-built only (needs K8s + LiveKit + Docker)",
  },
];

export default function AppWizard({ onComplete, onCancel }: Props) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [livekitUrl, setLivekitUrl] = useState("wss://livekit.bionicaisolutions.com");
  const [roomPrefix, setRoomPrefix] = useState("");
  const [enabledServices, setEnabledServices] = useState<string[]>([
    "livekit", "keycloak", "langfuse", "kubernetes", "postgres", "minio", "letta",
  ]);

  const createMutation = trpc.appsCrud.create.useMutation({
    onSuccess: () => {
      toast.success("App created! Provisioning started.");
      onComplete();
    },
    onError: (err) => {
      toast.error(`Failed to create app: ${err.message}`);
    },
  });

  const toggleService = (key: string) => {
    setEnabledServices((prev) =>
      prev.includes(key) ? prev.filter((s) => s !== key) : [...prev, key],
    );
  };

  const handleCreate = () => {
    createMutation.mutate({
      name,
      slug,
      description,
      livekitUrl,
      roomPrefix: roomPrefix || undefined,
      enabledServices,
    });
  };

  return (
    <Card>
      <CardContent className="pt-6">
        {/* Step indicators */}
        <div className="flex items-center gap-2 mb-8">
          {[1, 2, 3].map((s) => (
            <div key={s} className="flex items-center gap-2">
              <div
                className={`h-8 w-8 rounded-full flex items-center justify-center text-sm font-medium ${
                  s === step ? "bg-primary text-primary-foreground" : s < step ? "bg-green-500 text-white" : "bg-muted text-muted-foreground"
                }`}
              >
                {s}
              </div>
              {s < 3 && <div className="w-12 h-0.5 bg-muted" />}
            </div>
          ))}
          <span className="ml-2 text-sm text-muted-foreground">
            {step === 1 ? "Basic Info" : step === 2 ? "Services" : "Review"}
          </span>
        </div>

        {/* Step 1: Basic Info */}
        {step === 1 && (
          <div className="space-y-4 max-w-md">
            <div>
              <Label>App Name</Label>
              <Input
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (!slug || slug === slugify(name)) {
                    setSlug(slugify(e.target.value));
                  }
                }}
                placeholder="My AI App"
              />
            </div>
            <div>
              <Label>Slug</Label>
              <Input
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                placeholder="my-ai-app"
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground mt-1">Used for namespace, URLs, and identifiers</p>
            </div>
            <div>
              <Label>Description</Label>
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What does this app do?" />
            </div>
            <div>
              <Label>LiveKit URL</Label>
              <Input value={livekitUrl} onChange={(e) => setLivekitUrl(e.target.value)} />
            </div>
            <div>
              <Label>Room Prefix (optional)</Label>
              <Input value={roomPrefix} onChange={(e) => setRoomPrefix(e.target.value)} placeholder="my-app-" />
            </div>
            <div className="flex gap-2 pt-4">
              <Button variant="outline" onClick={onCancel}>Cancel</Button>
              <Button onClick={() => setStep(2)} disabled={!name || !slug}>Next</Button>
            </div>
          </div>
        )}

        {/* Step 2: Services */}
        {step === 2 && (
          <div className="space-y-4 max-w-md">
            <p className="text-sm text-muted-foreground">Select services to provision for this app:</p>
            {SERVICES.map((svc) => (
              <label key={svc.key} className="flex items-start gap-3 cursor-pointer">
                <Checkbox
                  checked={enabledServices.includes(svc.key)}
                  onCheckedChange={() => {
                    if (!svc.required) toggleService(svc.key);
                  }}
                  disabled={svc.required}
                />
                <div>
                  <span className="font-medium text-sm">{svc.label}</span>
                  {svc.required && <span className="text-xs text-muted-foreground ml-1">(required)</span>}
                  <p className="text-xs text-muted-foreground">{svc.description}</p>
                </div>
              </label>
            ))}
            <div className="flex gap-2 pt-4">
              <Button variant="outline" onClick={() => setStep(1)}>Back</Button>
              <Button onClick={() => setStep(3)}>Next</Button>
            </div>
          </div>
        )}

        {/* Step 3: Review */}
        {step === 3 && (
          <div className="space-y-4 max-w-md">
            <div className="space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Name</span><span className="font-medium">{name}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Slug</span><span className="font-mono">{slug}</span></div>
              {description && <div className="flex justify-between"><span className="text-muted-foreground">Description</span><span>{description}</span></div>}
              <div className="flex justify-between"><span className="text-muted-foreground">LiveKit URL</span><span className="text-xs">{livekitUrl}</span></div>
              <div className="pt-2">
                <span className="text-muted-foreground">Services:</span>
                <div className="flex flex-wrap gap-1 mt-1">
                  {enabledServices.map((s) => (
                    <span key={s} className="rounded bg-muted px-2 py-0.5 text-xs">{s}</span>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex gap-2 pt-4">
              <Button variant="outline" onClick={() => setStep(2)}>Back</Button>
              <Button onClick={handleCreate} disabled={createMutation.isPending}>
                {createMutation.isPending ? "Creating..." : "Create App"}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
