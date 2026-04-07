import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Mic, Volume2, Brain, Save } from "lucide-react";
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
  agentId: number;
}

export default function LiveKitSection(props: Props) {
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
              <Select value={props.sttProvider} onValueChange={(v) => { props.setSttProvider(v); props.setSttModel(""); }}>
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
              <Select value={props.llmProvider} onValueChange={(v) => { props.setLlmProvider(v); props.setLlmModel(""); }}>
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
              <Select value={props.ttsProvider} onValueChange={(v) => { props.setTtsProvider(v); props.setTtsVoice(""); }}>
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
