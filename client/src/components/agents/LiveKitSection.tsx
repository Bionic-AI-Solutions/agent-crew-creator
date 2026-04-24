import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Image, Mic, Upload, Volume2, Brain, Save, X } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";

function ProviderKeyInput({ agentId, provider }: { agentId: number; provider: string }) {
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const mutation = trpc.agentsCrud.setProviderKey.useMutation({
    onSuccess: () => { toast.success("API key saved to Vault"); setApiKey(""); setSaving(false); },
    onError: (err: any) => { toast.error(err.message); setSaving(false); },
  });

  return (
    <div>
      <Label className="text-xs">API Key</Label>
      <div className="flex gap-2">
        <Input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-..."
          className="flex-1"
        />
        <Button
          size="sm"
          variant="outline"
          disabled={!apiKey || saving}
          onClick={() => {
            setSaving(true);
            mutation.mutate({ agentId, provider, apiKey });
          }}
        >
          <Save className="h-3 w-3 mr-1" /> Save
        </Button>
      </div>
      <p className="text-xs text-muted-foreground mt-1">Stored securely in Vault</p>
    </div>
  );
}
import {
  STT_PROVIDERS, STT_MODELS,
  LLM_PROVIDERS, LLM_MODELS,
  TTS_PROVIDERS, TTS_VOICES,
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
  agentId: number;
}

export default function LiveKitSection(props: Props) {
  const avatarFileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const models = STT_MODELS[props.sttProvider] || [];
    if (models.length > 0 && !models.some((model) => model.value === props.sttModel)) {
      props.setSttModel(models[0].value);
    }
  }, [props.sttProvider, props.sttModel, props.setSttModel]);

  useEffect(() => {
    if (props.llmProvider === "custom") return;
    const models = LLM_MODELS[props.llmProvider] || [];
    if (models.length > 0 && !models.some((model) => model.value === props.llmModel)) {
      props.setLlmModel(models[0].value);
    }
  }, [props.llmProvider, props.llmModel, props.setLlmModel]);

  useEffect(() => {
    const voices = TTS_VOICES[props.ttsProvider] || [];
    if (voices.length > 0 && !voices.some((voice) => voice.value === props.ttsVoice)) {
      props.setTtsVoice(voices[0].value);
    }
  }, [props.ttsProvider, props.ttsVoice, props.setTtsVoice]);

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
                props.setSttModel((STT_MODELS[v] || [])[0]?.value || "");
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
              <Select value={props.sttModel} onValueChange={props.setSttModel}>
                <SelectTrigger><SelectValue placeholder="Select model" /></SelectTrigger>
                <SelectContent>
                  {(STT_MODELS[props.sttProvider] || []).map((m) => (
                    <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {STT_PROVIDERS.find((p) => p.value === props.sttProvider)?.description}
          </p>
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
                props.setLlmModel(v === "custom" ? "" : (LLM_MODELS[v] || [])[0]?.value || "");
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
              {props.llmProvider === "custom" ? (
                <Input value={props.llmModel} onChange={(e) => props.setLlmModel(e.target.value)} placeholder="model-name" />
              ) : (
                <Select value={props.llmModel} onValueChange={props.setLlmModel}>
                  <SelectTrigger><SelectValue placeholder="Select model" /></SelectTrigger>
                  <SelectContent>
                    {(LLM_MODELS[props.llmProvider] || []).map((m) => (
                      <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {LLM_PROVIDERS.find((p) => p.value === props.llmProvider)?.description}
          </p>
          {LLM_PROVIDERS.find((p) => p.value === props.llmProvider)?.requiresKey && (
            <ProviderKeyInput agentId={props.agentId} provider={props.llmProvider} />
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
                props.setTtsVoice((TTS_VOICES[v] || [])[0]?.value || "");
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
              <Select value={props.ttsVoice} onValueChange={props.setTtsVoice}>
                <SelectTrigger><SelectValue placeholder="Select voice" /></SelectTrigger>
                <SelectContent>
                  {(TTS_VOICES[props.ttsProvider] || []).map((v) => (
                    <SelectItem key={v.value} value={v.value}>{v.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {TTS_PROVIDERS.find((p) => p.value === props.ttsProvider)?.description}
          </p>
        </CardContent>
      </Card>

      {/* Avatar */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Image className="h-4 w-4" /> Avatar
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <Checkbox
              checked={props.avatarEnabled}
              onCheckedChange={(checked) => props.setAvatarEnabled(checked === true)}
              id="avatar-enabled"
            />
            <Label htmlFor="avatar-enabled" className="text-sm">Enable talking-head avatar</Label>
          </div>

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
        </CardContent>
      </Card>

      {/* System Prompt */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">System Prompt</CardTitle>
        </CardHeader>
        <CardContent>
          <Textarea
            value={props.systemPrompt}
            onChange={(e) => props.setSystemPrompt(e.target.value)}
            placeholder="You are a helpful AI assistant..."
            rows={8}
            className="font-mono text-xs"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Instructions for the LiveKit voice agent (the user-facing conversational agent)
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
