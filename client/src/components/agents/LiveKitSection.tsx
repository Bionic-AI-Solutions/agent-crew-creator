import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Image, Mic, Upload, Volume2, Brain, Save, X, User } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";

/**
 * A key is optional here. An agent with no override of its own runs on the
 * org-wide key in Vault — the deployer has always fallen back to it — so this
 * says which key is in force rather than presenting an empty box that reads
 * as an unmet requirement.
 */
function ProviderKeyInput({
  agentId,
  provider,
  onSaved,
}: {
  agentId: number;
  provider: string;
  onSaved?: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const trpcUtils = trpc.useUtils();

  const { data: status } = trpc.agentsCrud.getProviderKeyStatus.useQuery({ agentId, provider });
  const source = status?.source ?? "none";

  const refresh = () => {
    trpcUtils.agentsCrud.getProviderKeyStatus.invalidate({ agentId, provider });
    onSaved?.();
  };

  const mutation = trpc.agentsCrud.setProviderKey.useMutation({
    onSuccess: (data: any) => {
      toast.success(`Key validated • ${data?.modelCount ?? 0} models available`);
      setApiKey("");
      setSaving(false);
      refresh();
    },
    onError: (err: any) => {
      toast.error(err.message);
      setSaving(false);
    },
  });

  const clearMutation = trpc.agentsCrud.clearProviderKey.useMutation({
    onSuccess: (data: any) => {
      toast.success(
        data?.source === "shared"
          ? "Override removed — now using the shared key"
          : "Override removed — no shared key is configured for this provider",
      );
      refresh();
    },
    onError: (err: any) => toast.error(err.message),
  });

  return (
    <div>
      <div className="flex items-center gap-2">
        <Label className="text-xs">API Key</Label>
        <span className="text-[10px] text-muted-foreground">optional</span>
      </div>
      <div className="flex gap-2">
        <Input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={source === "agent" ? "Replace this agent's key" : "Leave empty to use the shared key"}
          className="flex-1"
        />
        <Button
          size="sm"
          variant="outline"
          disabled={!apiKey || saving}
          onClick={() => {
            setSaving(true);
            mutation.mutate({ agentId, provider, apiKey: apiKey.trim() });
          }}
        >
          <Save className="h-3 w-3 mr-1" /> Test & Save
        </Button>
      </div>

      {source === "agent" ? (
        <p className="text-xs text-muted-foreground mt-1 flex items-center gap-2">
          <span className="text-foreground">This agent has its own key.</span>
          <button
            type="button"
            className="underline hover:text-foreground"
            onClick={() => clearMutation.mutate({ agentId, provider })}
            disabled={clearMutation.isPending}
          >
            Use the shared key instead
          </button>
        </p>
      ) : source === "shared" ? (
        <p className="text-xs text-muted-foreground mt-1">
          Using the shared organisation key from Vault. Add one above only to override it for this agent.
        </p>
      ) : (
        <p className="text-xs text-amber-600 mt-1">
          No key for this provider — neither on this agent nor shared. Add one, or the agent will deploy without it.
        </p>
      )}
    </div>
  );
}

/**
 * Live voice/model picker for STT and TTS providers.
 *
 * Same shape as LiveModelPicker but uses agentsCrud.listProviderVoices, which
 * serves both pipelines. The server always answers with a list and says
 * whether it is live or a fallback, so this component holds no table of its
 * own — the drift between two such tables is what made 184 of gpu-ai's 191
 * voices unselectable.
 */
function LiveVoicePicker({
  agentId,
  provider,
  value,
  onChange,
  pipeline = "tts",
}: {
  agentId: number;
  provider: string;
  value: string;
  onChange: (v: string) => void;
  /** gpu-ai serves both pipelines; says which list to ask for. */
  pipeline?: "tts" | "stt";
}) {
  const [filter, setFilter] = useState("");
  const { data, isLoading, isError, error } = trpc.agentsCrud.listProviderVoices.useQuery(
    { agentId, provider, pipeline },
    { enabled: !!provider, retry: false },
  );

  // Seed once the list arrives and nothing is chosen — replaces the old
  // client-side tables, which could only seed from a stale copy of the truth.
  const voicesLoaded = data?.voices ?? [];
  useEffect(() => {
    if (!value && voicesLoaded.length > 0) onChange(voicesLoaded[0].id);
  }, [value, voicesLoaded, onChange]);

  // The server always answers with a list plus its provenance, so there is no
  // second table here to choose between. Only the genuinely empty case is left.
  if (!isLoading && !isError && !data?.voices?.length) {
    return (
      <div className="text-xs text-amber-600">
        {data?.hasKey === false
          ? "No key for this provider — neither on this agent nor shared in Vault. Add one below to load voices."
          : "No voices available for this provider."}
      </div>
    );
  }

  if (isLoading) {
    return <Input value="Loading voices…" disabled />;
  }
  if (isError) {
    return (
      <div className="text-xs text-destructive">
        {(error as any)?.message || "Failed to load voices"}
      </div>
    );
  }

  const voices: Array<{ id: string; name?: string; description?: string; language?: string }> =
    data?.voices ?? [];
  const filtered = filter
    ? voices.filter((v) => {
        const haystack = `${v.id} ${v.name || ""} ${v.description || ""}`.toLowerCase();
        return haystack.includes(filter.toLowerCase());
      })
    : voices;
  const valueInList = filtered.some((v) => v.id === value);
  const options = !valueInList && value ? [{ id: value }, ...filtered] : filtered;

  return (
    <div className="space-y-1">
      {voices.length > 20 && (
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={`Search ${voices.length} voices…`}
          className="h-8 text-xs"
        />
      )}
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger><SelectValue placeholder="Select voice" /></SelectTrigger>
        <SelectContent className="max-h-72">
          {options.length === 0 ? (
            <div className="px-2 py-1 text-xs text-muted-foreground">No matches</div>
          ) : (
            options.map((v: any) => (
              <SelectItem key={v.id} value={v.id}>
                <div className="flex flex-col">
                  <span className="text-sm">{v.name || v.id}</span>
                  {(v.language || v.description) && (
                    <span className="text-[10px] text-muted-foreground">
                      {[v.language, v.description].filter(Boolean).join(" • ")}
                    </span>
                  )}
                </div>
              </SelectItem>
            ))
          )}
        </SelectContent>
      </Select>
      {voices.length > 0 && (
        <p className="text-[10px] text-muted-foreground">
          {voices.length} voices available • live from {provider}
        </p>
      )}
    </div>
  );
}

/**
 * Live model picker — sources options from the provider's /v1/models
 * endpoint using whatever key is in Vault for this agent. Replaces the
 * old hardcoded model table so the user can never type a model id
 * that doesn't exist on the provider.
 *
 * For OpenRouter (~350 models) shows a typeahead-style filter; for
 * smaller providers just renders the full list.
 */
function LiveModelPicker({
  agentId,
  provider,
  value,
  onChange,
  toolUseOnly,
}: {
  agentId: number;
  provider: string;
  value: string;
  onChange: (v: string) => void;
  /** When true, only show models that support tool/function calling. */
  toolUseOnly?: boolean;
}) {
  const [filter, setFilter] = useState("");
  const { data, isLoading, isError, error, refetch } = trpc.agentsCrud.listProviderModels.useQuery(
    { agentId, provider, toolUseOnly },
    { enabled: !!provider && provider !== "custom", retry: false },
  );

  // Seed from the live list when nothing is chosen. The old client-side table
  // did this from a stale copy; the provider's own /v1/models is the only
  // list that can be right.
  const modelsLoaded = data?.models ?? [];
  useEffect(() => {
    if (provider === "custom") return;
    if (!value && modelsLoaded.length > 0) {
      const first = modelsLoaded[0];
      onChange(typeof first === "string" ? first : first.id);
    }
  }, [value, modelsLoaded, onChange, provider]);

  if (provider === "custom") {
    return (
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="model-name"
      />
    );
  }

  if (isLoading) {
    return <Input value="Loading models…" disabled />;
  }
  if (isError) {
    return (
      <div className="text-xs text-destructive">
        {(error as any)?.message || "Failed to load models"}
      </div>
    );
  }
  if (!data?.hasKey) {
    return (
      <div className="text-xs text-amber-600">
        No key for this provider — neither on this agent nor shared in Vault. Add one below to load the model list.
      </div>
    );
  }

  const models: Array<{ id: string; description?: string; contextLength?: number; supportsTools?: boolean }> =
    data?.models ?? [];
  const filtered = filter
    ? models.filter((m) => m.id.toLowerCase().includes(filter.toLowerCase()))
    : models;

  // Always include the currently-saved value as a selectable option even if
  // it's no longer in the live list (defensive — never silently lose a save).
  const valueInList = filtered.some((m) => m.id === value);
  const options = !valueInList && value ? [{ id: value }, ...filtered] : filtered;

  return (
    <div className="space-y-1">
      {models.length > 20 && (
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={`Search ${models.length} models…`}
          className="h-8 text-xs"
        />
      )}
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue placeholder="Select model" />
        </SelectTrigger>
        <SelectContent className="max-h-72">
          {options.length === 0 ? (
            <div className="px-2 py-1 text-xs text-muted-foreground">
              {toolUseOnly ? "No models with tool support found" : "No matches"}
            </div>
          ) : (
            options.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                <div className="flex flex-col">
                  <span className="text-sm flex items-center gap-1">
                    {m.id}
                    {m.supportsTools === true && (
                      <span className="text-[9px] px-1 py-0.5 rounded bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300">tools</span>
                    )}
                  </span>
                  {m.contextLength && (
                    <span className="text-[10px] text-muted-foreground">
                      {Math.round(m.contextLength / 1000)}k context
                    </span>
                  )}
                </div>
              </SelectItem>
            ))
          )}
        </SelectContent>
      </Select>
      <p className="text-[10px] text-muted-foreground">
        {models.length} models available{toolUseOnly ? " (tool-use only)" : ""} • live from {provider}
      </p>
    </div>
  );
}
import {
  STT_PROVIDERS,
  LLM_PROVIDERS,
  TTS_PROVIDERS, TTS_LANGUAGES,
  providerRequiresKey,
} from "@shared/providerOptions";

interface Props {
  sttProvider: string;
  setSttProvider: (v: string) => void;
  sttModel: string;
  setSttModel: (v: string) => void;
  llmProvider: string;
  setLlmProvider: (v: string) => void;
  llmModel: string;
  setLlmModel: (v: string) => void;
  ttsProvider: string;
  setTtsProvider: (v: string) => void;
  ttsVoice: string;
  setTtsVoice: (v: string) => void;
  ttsLanguage: string;
  setTtsLanguage: (v: string) => void;
  systemPrompt: string;
  setSystemPrompt: (v: string) => void;
  avatarEnabled: boolean;
  setAvatarEnabled: (v: boolean) => void;
  avatarProvider: string;
  setAvatarProvider: (v: string) => void;
  avatarReferenceImage: string;
  setAvatarReferenceImage: (v: string) => void;
  avatarName: string;
  setAvatarName: (v: string) => void;
  avatarImageUrl: string;
  visionEnabled: boolean;
  setVisionEnabled: (v: boolean) => void;
  domReadEnabled: boolean;
  setDomReadEnabled: (v: boolean) => void;
  domControlEnabled: boolean;
  setDomControlEnabled: (v: boolean) => void;
  domActionDenylist: string;
  setDomActionDenylist: (v: string) => void;
  backgroundAudioEnabled: boolean;
  setBackgroundAudioEnabled: (v: boolean) => void;
  busyAudioEnabled: boolean;
  setBusyAudioEnabled: (v: boolean) => void;
  agentId: number;
}

function AvatarUpload({ agentId, currentUrl }: { agentId: number; currentUrl: string }) {
  const [preview, setPreview] = useState<string>("");
  const [uploading, setUploading] = useState(false);
  const [fileName, setFileName] = useState<string>(currentUrl ? currentUrl.split("/").pop() || "" : "");
  const uploadMutation = trpc.agentsCrud.uploadAvatarImage.useMutation({
    onSuccess: () => {
      toast.success("Avatar image saved (replaces previous)");
      setUploading(false);
    },
    onError: (err: any) => {
      toast.error(err.message);
      setUploading(false);
    },
  });

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Please select an image file");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error("Image must be under 5MB");
      return;
    }
    setUploading(true);
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      setPreview(dataUrl);
      const base64 = dataUrl.split(",")[1];
      uploadMutation.mutate({
        agentId,
        imageBase64: base64,
        filename: file.name,
      });
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="flex gap-4 items-start">
      <div className="w-20 h-20 rounded-lg border-2 border-dashed border-muted-foreground/30 flex items-center justify-center overflow-hidden bg-muted/30 shrink-0">
        {preview ? (
          <img src={preview} alt="Avatar" className="w-full h-full object-cover rounded-lg" />
        ) : currentUrl ? (
          <div className="text-center">
            <User className="h-6 w-6 text-green-500 mx-auto" />
            <span className="text-[9px] text-green-500">Saved</span>
          </div>
        ) : (
          <User className="h-8 w-8 text-muted-foreground/40" />
        )}
      </div>
      <div className="space-y-2">
        {fileName && (
          <p className="text-xs text-green-500">✓ {fileName.length > 30 ? fileName.slice(0, 27) + "..." : fileName}</p>
        )}
        <p className="text-xs text-muted-foreground">
          {currentUrl ? "Upload a new image to replace." : "Upload a clear, front-facing face image."}
        </p>
        <label className="inline-flex items-center gap-1.5 text-xs cursor-pointer px-3 py-1.5 border rounded-md hover:bg-muted transition-colors">
          <Upload className="h-3 w-3" />
          {uploading ? "Uploading..." : currentUrl ? "Replace Image" : "Choose Image"}
          <input type="file" accept="image/*" className="hidden" onChange={handleFile} disabled={uploading} />
        </label>
      </div>
    </div>
  );
}

function AudioUpload({ agentId, audioType, label }: { agentId: number; audioType: "ambient" | "thinking"; label: string }) {
  const [uploading, setUploading] = useState(false);
  const [fileName, setFileName] = useState<string>("");
  const uploadMutation = trpc.agentsCrud.uploadAudioFile.useMutation({
    onSuccess: () => {
      toast.success(`${label} saved (replaces previous)`);
      setUploading(false);
    },
    onError: (err: any) => {
      toast.error(err.message);
      setUploading(false);
      setFileName("");
    },
  });

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { toast.error("Max 10MB"); return; }
    setUploading(true);
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = (reader.result as string).split(",")[1];
      uploadMutation.mutate({ agentId, audioBase64: base64, filename: file.name, audioType });
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="ml-6">
      <Label className="text-[10px] text-muted-foreground">{label}</Label>
      {fileName && (
        <p className="text-[10px] text-green-500 mt-1">✓ {fileName.length > 35 ? fileName.slice(0, 32) + "..." : fileName}</p>
      )}
      <label className="inline-flex items-center gap-1.5 text-xs cursor-pointer px-3 py-1.5 border rounded-md hover:bg-muted transition-colors mt-1">
        <Upload className="h-3 w-3" />
        {uploading ? "Uploading..." : fileName ? "Replace Audio File" : "Choose Audio File"}
        <input type="file" accept="audio/*" className="hidden" onChange={handleFile} disabled={uploading} />
      </label>
      <p className="text-[10px] text-muted-foreground mt-1">MP3, WAV, or OGG (max 10MB). Replaces previous file.</p>
    </div>
  );
}

export default function LiveKitSection(props: Props) {
  const trpcUtils = trpc.useUtils();
  const avatarFileInputRef = useRef<HTMLInputElement>(null);

  // No client-side seeding effects. Each picker seeds itself from the list the
  // server sent once nothing is chosen, so there is exactly one answer to
  // "what can this provider do" and it is not kept here.

  useEffect(() => {
    if (props.ttsProvider !== "sarvam") return;
    if (!TTS_LANGUAGES.some((lang) => lang.value === props.ttsLanguage)) {
      props.setTtsLanguage(TTS_LANGUAGES[0].value);
    }
  }, [props.ttsProvider, props.ttsLanguage, props.setTtsLanguage]);

  const handleAvatarFile = (file: File) => {
    if (!file.type.startsWith("image/")) {
      toast.error("Please upload an image file");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.error("Avatar image must be smaller than 2MB");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      props.setAvatarReferenceImage(String(reader.result || ""));
      if (!props.avatarName) {
        props.setAvatarName(file.name.replace(/\.[^.]+$/, "").slice(0, 100));
      }
      toast.success("Avatar image staged. Click Save to persist it.");
    };
    reader.onerror = () => toast.error("Could not read avatar image");
    reader.readAsDataURL(file);
  };

  return (
    <div className="space-y-4">
      {/* Avatar */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <User className="h-4 w-4" /> Avatar (BitHuman)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <Checkbox
              id="avatar-toggle"
              checked={props.avatarEnabled}
              onCheckedChange={(v) => props.setAvatarEnabled(v === true)}
            />
            <Label htmlFor="avatar-toggle" className="text-xs cursor-pointer">
              Enable Avatar
            </Label>
          </div>
          {props.avatarEnabled && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Provider</Label>
                  <Select value={props.avatarProvider} onValueChange={props.setAvatarProvider}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="flashhead">FlashHead</SelectItem>
                      <SelectItem value="bithuman">BitHuman (legacy)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">Avatar Name</Label>
                  <Input
                    value={props.avatarName}
                    onChange={(e) => props.setAvatarName(e.target.value)}
                    placeholder="Avatar display name"
                  />
                </div>
              </div>
              {props.avatarProvider === "bithuman" ? (
                <>
                  <AvatarUpload agentId={props.agentId} currentUrl={props.avatarImageUrl} />
                  <p className="text-[10px] text-muted-foreground">
                    GPU Server: 192.168.0.10:8089 • When avatar is enabled, audio output is handled by the avatar video stream.
                  </p>
                </>
              ) : (
                <div>
                  <Label className="text-xs">Reference Image</Label>
                  <div className="mt-1 flex gap-3">
                    <div className="h-24 w-24 overflow-hidden rounded-md border bg-muted flex items-center justify-center">
                      {props.avatarReferenceImage ? (
                        <img
                          src={props.avatarReferenceImage}
                          alt="Avatar reference"
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <Image className="h-8 w-8 text-muted-foreground" />
                      )}
                    </div>
                    <div className="flex-1 space-y-2">
                      <Input
                        value={props.avatarReferenceImage}
                        onChange={(e) => props.setAvatarReferenceImage(e.target.value)}
                        placeholder="https://... or upload an image"
                      />
                      <div className="flex gap-2">
                        <Button type="button" size="sm" variant="outline" onClick={() => avatarFileInputRef.current?.click()}>
                          <Upload className="h-3 w-3 mr-1" /> Upload Image
                        </Button>
                        {props.avatarReferenceImage && (
                          <Button type="button" size="sm" variant="ghost" onClick={() => props.setAvatarReferenceImage("")}>
                            <X className="h-3 w-3 mr-1" /> Clear
                          </Button>
                        )}
                      </div>
                      <input
                        ref={avatarFileInputRef}
                        type="file"
                        className="hidden"
                        accept="image/*"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) handleAvatarFile(file);
                          e.currentTarget.value = "";
                        }}
                      />
                      <p className="text-xs text-muted-foreground">
                        Uploaded images are stored with this agent config after Save.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Media Capabilities */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Volume2 className="h-4 w-4" /> Media Capabilities
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <Checkbox
              id="vision-toggle"
              checked={props.visionEnabled}
              onCheckedChange={(v) => props.setVisionEnabled(v === true)}
            />
            <Label htmlFor="vision-toggle" className="text-xs cursor-pointer">
              Enable Vision (Camera)
            </Label>
          </div>
          <p className="text-[10px] text-muted-foreground ml-6">
            Allow the agent to see the user's camera feed and respond to visual input.
          </p>

          <div className="flex items-center gap-2">
            <Checkbox
              id="dom-read-toggle"
              checked={props.domReadEnabled}
              onCheckedChange={(v) => {
                const on = v === true;
                props.setDomReadEnabled(on);
                // Acting names a control from the current page listing, so
                // control without reading has nothing to address. Turning
                // read off takes control with it rather than leaving a
                // checkbox ticked that the server will ignore.
                if (!on) props.setDomControlEnabled(false);
              }}
            />
            <Label htmlFor="dom-read-toggle" className="text-xs cursor-pointer">
              Read the page (DOM)
            </Label>
          </div>
          <p className="text-[10px] text-muted-foreground ml-6">
            The agent reads the controls on the page it is embedded in — their
            names, roles and whether they are visible — so it can name them
            exactly and check that a step actually worked. Vision answers what
            the page <em>looks</em> like; this answers what is <em>on</em> it.
            Popup embeds only.
          </p>
          {props.domReadEnabled && props.llmProvider !== "gpu-ai" && (
            <p className="text-[10px] text-amber-600 ml-6">
              Costs roughly a second per turn on this LLM. The page listing
              rides on the user's turn, which stops the agent from starting its
              reply early — it waits for the listing rather than answering
              without having seen the page. Worth it where the agent is guiding
              someone through a screen; not worth it for a purely
              conversational agent.
            </p>
          )}
          {props.domReadEnabled && props.llmProvider === "gpu-ai" && (
            <p className="text-[10px] text-muted-foreground ml-6">
              No latency cost on this LLM: replying early is already disabled
              for gpu-ai, so there is nothing for the page listing to delay.
            </p>
          )}

          <div className="flex items-center gap-2">
            <Checkbox
              id="dom-control-toggle"
              checked={props.domControlEnabled}
              disabled={!props.domReadEnabled}
              onCheckedChange={(v) => props.setDomControlEnabled(v === true)}
            />
            <Label
              htmlFor="dom-control-toggle"
              className={
                "text-xs cursor-pointer" +
                (props.domReadEnabled ? "" : " text-muted-foreground")
              }
            >
              Control the page (click and type)
            </Label>
          </div>
          <p className="text-[10px] text-muted-foreground ml-6">
            {props.domReadEnabled
              ? "The agent performs the steps itself. Named controls below are refused by the widget and handed back to the user, and that refusal is code, not prompt wording. Each embed token must also permit it and list its allowed origins."
              : "Requires “Read the page”. An action names a control from the current page listing."}
          </p>

          {props.domControlEnabled && props.domReadEnabled && (
            <div className="ml-6 space-y-1">
              <Label htmlFor="dom-denylist" className="text-xs">
                Never activate these controls
              </Label>
              <Input
                id="dom-denylist"
                value={props.domActionDenylist}
                onChange={(e) => props.setDomActionDenylist(e.target.value)}
                // 100 terms of 60 characters, matching the server. Refused
                // there either way; stopping here explains itself sooner.
                maxLength={6100}
                placeholder="send, delete, pay, submit, transfer"
                className="h-8 text-xs"
              />
              <p className="text-[10px] text-muted-foreground">
                Comma separated, matched against a control's accessible name,
                case-insensitively and on whole words. The agent asks the user
                instead of pressing these.
                {" "}
                <strong>Which names belong here depends on whose page it is.</strong>{" "}
                On a page the visitor does not own, “send” must be on the list.
                On your own support form, submitting is the job — take it off,
                and leave the ones that spend money or destroy data.
                {props.domActionDenylist.trim() === "" && (
                  <>
                    {" "}
                    <span className="text-amber-600">
                      Empty means nothing is refused.
                    </span>
                  </>
                )}
              </p>
            </div>
          )}

          <div className="flex items-center gap-2">
            <Checkbox
              id="bg-audio-toggle"
              checked={props.backgroundAudioEnabled}
              onCheckedChange={(v) => props.setBackgroundAudioEnabled(v === true)}
            />
            <Label htmlFor="bg-audio-toggle" className="text-xs cursor-pointer">
              Background Music
            </Label>
          </div>
          <p className="text-[10px] text-muted-foreground ml-6">
            Play ambient background music during the session.
          </p>
          {props.backgroundAudioEnabled && (
            <AudioUpload agentId={props.agentId} audioType="ambient" label="Ambient Sound File" />
          )}

          <div className="flex items-center gap-2">
            <Checkbox
              id="busy-audio-toggle"
              checked={props.busyAudioEnabled}
              onCheckedChange={(v) => props.setBusyAudioEnabled(v === true)}
            />
            <Label htmlFor="busy-audio-toggle" className="text-xs cursor-pointer">
              Busy Audio (Thinking)
            </Label>
          </div>
          <p className="text-[10px] text-muted-foreground ml-6">
            Play a subtle audio cue while the agent is thinking/processing.
          </p>
          {props.busyAudioEnabled && (
            <AudioUpload agentId={props.agentId} audioType="thinking" label="Thinking Sound File" />
          )}
        </CardContent>
      </Card>

      {/* STT */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Mic className="h-4 w-4" /> Speech-to-Text (STT)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Provider</Label>
              <Select value={props.sttProvider} onValueChange={(v) => {
                props.setSttProvider(v);
                props.setSttModel("");   // picker reseeds from the live list
              }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {STT_PROVIDERS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Model</Label>
              <LiveVoicePicker
                agentId={props.agentId}
                provider={props.sttProvider}
                value={props.sttModel}
                onChange={props.setSttModel}
                pipeline="stt"
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {STT_PROVIDERS.find((p) => p.value === props.sttProvider)?.description}
          </p>
          {providerRequiresKey(STT_PROVIDERS, props.sttProvider) && (
            <ProviderKeyInput
              agentId={props.agentId}
              provider={props.sttProvider}
              onSaved={() => {
                trpcUtils.agentsCrud.listProviderVoices.invalidate({
                  agentId: props.agentId,
                  provider: props.sttProvider,
                });
              }}
            />
          )}
        </CardContent>
      </Card>

      {/* LLM */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Brain className="h-4 w-4" /> Language Model (LLM)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Provider</Label>
              <Select value={props.llmProvider} onValueChange={(v) => {
                props.setLlmProvider(v);
                props.setLlmModel("");   // picker reseeds from the live list
              }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {LLM_PROVIDERS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Model</Label>
              <LiveModelPicker
                agentId={props.agentId}
                provider={props.llmProvider}
                value={props.llmModel}
                onChange={props.setLlmModel}
                toolUseOnly
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {LLM_PROVIDERS.find((p) => p.value === props.llmProvider)?.description}
          </p>
          {/* Always show the key input for non-internal providers — gpu-ai
              has no key. The validation flow re-fetches the model list on
              save success so the dropdown above immediately populates. */}
          {providerRequiresKey(LLM_PROVIDERS, props.llmProvider) && (
            <ProviderKeyInput
              agentId={props.agentId}
              provider={props.llmProvider}
              onSaved={() => {
                // The query is keyed by (agentId, provider) — invalidate it
                // so LiveModelPicker re-runs against the new key. The trpc
                // utils API does this cleanly.
                trpcUtils.agentsCrud.listProviderModels.invalidate({
                  agentId: props.agentId,
                  provider: props.llmProvider,
                });
              }}
            />
          )}
        </CardContent>
      </Card>

      {/* TTS */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Volume2 className="h-4 w-4" /> Text-to-Speech (TTS)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Provider</Label>
              <Select value={props.ttsProvider} onValueChange={(v) => {
                props.setTtsProvider(v);
                props.setTtsVoice("");   // picker reseeds from the live list
              }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TTS_PROVIDERS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Voice</Label>
              <LiveVoicePicker
                agentId={props.agentId}
                provider={props.ttsProvider}
                value={props.ttsVoice}
                onChange={props.setTtsVoice}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {TTS_PROVIDERS.find((p) => p.value === props.ttsProvider)?.description}
          </p>
          {props.ttsProvider === "sarvam" && (
            <div>
              <Label className="text-xs">Language</Label>
              <Select value={props.ttsLanguage} onValueChange={props.setTtsLanguage}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TTS_LANGUAGES.map((l) => (
                    <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[10px] text-muted-foreground mt-1">
                Sarvam requires an explicit target language — it does not auto-detect.
              </p>
            </div>
          )}
          {providerRequiresKey(TTS_PROVIDERS, props.ttsProvider) && (
            <ProviderKeyInput
              agentId={props.agentId}
              provider={props.ttsProvider}
              onSaved={() => {
                trpcUtils.agentsCrud.listProviderVoices.invalidate({
                  agentId: props.agentId,
                  provider: props.ttsProvider,
                });
              }}
            />
          )}
        </CardContent>
      </Card>

      {/* Agent Persona */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Agent Persona</CardTitle>
        </CardHeader>
        <CardContent>
          <Textarea
            value={props.systemPrompt}
            onChange={(e) => props.setSystemPrompt(e.target.value)}
            placeholder="You are a friendly physics tutor who uses analogies and real-world examples to make complex concepts accessible..."
            rows={8}
            className="font-mono text-xs"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Define the agent's personality, speaking style, subject domain, and teaching approach.
            Behavioral rules (delegation, lecture mode, tool usage, engagement) are enforced automatically and cannot be changed here.
          </p>
          <details className="mt-3">
            <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground flex items-center gap-1">
              <span>View enforced rules (11 rules, always active)</span>
            </summary>
            <pre className="mt-2 p-3 bg-muted/50 rounded-md text-[10px] leading-relaxed text-muted-foreground whitespace-pre-wrap font-mono border max-h-64 overflow-y-auto">
{`1. DELEGATION — use delegate_to_letta for research/analysis/deep work
2. TOOL SILENCE — no narration before/during/after tool calls
3. LECTURE MODE — walk through ALL bullet points, explain in depth
4. SCREEN SYNC — never reference visuals until confirmed visible on screen
5. NO REPETITION — never repeat covered topics unless user asks
6. PACING & Q/A — pause between sections, ask substantive questions, wait for answers, max 2 review questions per topic
7. VOICE CONSTRAINTS — terminal punctuation, no markdown/lists/URLs
8. GREETING — ask user's name on first interaction
9. IDENTITY — use their name, not "student"/"professor"
10. INTERRUPTION — address questions, then resume lecture material
11. EMAIL COLLECTION — ask for email to send session summary`}
            </pre>
          </details>
        </CardContent>
      </Card>
    </div>
  );
}
