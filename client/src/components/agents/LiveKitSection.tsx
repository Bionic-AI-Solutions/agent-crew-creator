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
  const mutation = trpc.agentsCrud.setProviderKey.useMutation({
    onSuccess: (data: any) => {
      toast.success(`Key validated • ${data?.modelCount ?? 0} models available`);
      setApiKey("");
      setSaving(false);
      onSaved?.();
    },
    onError: (err: any) => {
      toast.error(err.message);
      setSaving(false);
    },
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
            mutation.mutate({ agentId, provider, apiKey: apiKey.trim() });
          }}
        >
          <Save className="h-3 w-3 mr-1" /> Test & Save
        </Button>
      </div>
      <p className="text-xs text-muted-foreground mt-1">
        The key is validated against the provider before saving to Vault.
      </p>
    </div>
  );
}

/**
 * Live voice/model picker for STT and TTS providers.
 *
 * Same shape as LiveModelPicker but uses agentsCrud.listProviderVoices
 * which understands cartesia / elevenlabs / deepgram / openai TTS. For
 * gpu-ai (internal) and "custom" providers, falls back to a static list
 * passed via the `staticOptions` prop.
 */
function LiveVoicePicker({
  agentId,
  provider,
  value,
  onChange,
  staticOptions,
}: {
  agentId: number;
  provider: string;
  value: string;
  onChange: (v: string) => void;
  staticOptions: Array<{ value: string; label: string }>;
}) {
  const [filter, setFilter] = useState("");
  const { data, isLoading, isError, error } = trpc.agentsCrud.listProviderVoices.useQuery(
    { agentId, provider },
    { enabled: !!provider, retry: false },
  );

  // gpu-ai / custom / unsupported → static fallback list (TTS_VOICES /
  // STT_MODELS table from shared/providerOptions). Keeps internal-only
  // providers usable without an API key.
  if (data?.supported === false || (!isLoading && !isError && data?.hasKey === false && !data?.voices?.length)) {
    if (staticOptions.length > 0) {
      return (
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger><SelectValue placeholder="Select voice" /></SelectTrigger>
          <SelectContent>
            {staticOptions.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }
    return (
      <div className="text-xs text-amber-600">
        Add an API key for this provider to load voices.
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
 * old hardcoded LLM_MODELS table so the user can never type a model id
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
}: {
  agentId: number;
  provider: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const { data, isLoading, isError, error, refetch } = trpc.agentsCrud.listProviderModels.useQuery(
    { agentId, provider },
    { enabled: !!provider && provider !== "custom", retry: false },
  );

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
        No API key set for this provider yet. Add one below to load the model list.
      </div>
    );
  }

  const models: Array<{ id: string; description?: string; contextLength?: number }> =
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
            <div className="px-2 py-1 text-xs text-muted-foreground">No matches</div>
          ) : (
            options.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                <div className="flex flex-col">
                  <span className="text-sm">{m.id}</span>
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
        {models.length} models available • live from {provider}
      </p>
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
  const trpcUtils = trpc.useUtils();
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
              <LiveVoicePicker
                agentId={props.agentId}
                provider={props.sttProvider}
                value={props.sttModel}
                onChange={props.setSttModel}
                staticOptions={(STT_MODELS[props.sttProvider] || []).map((m) => ({
                  value: m.value, label: m.label,
                }))}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {STT_PROVIDERS.find((p) => p.value === props.sttProvider)?.description}
          </p>
          {props.sttProvider !== "gpu-ai" && props.sttProvider !== "custom" && (
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
              <LiveModelPicker
                agentId={props.agentId}
                provider={props.llmProvider}
                value={props.llmModel}
                onChange={props.setLlmModel}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {LLM_PROVIDERS.find((p) => p.value === props.llmProvider)?.description}
          </p>
          {/* Always show the key input for non-internal providers — gpu-ai
              has no key. The validation flow re-fetches the model list on
              save success so the dropdown above immediately populates. */}
          {props.llmProvider !== "gpu-ai" && props.llmProvider !== "custom" && (
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
              <LiveVoicePicker
                agentId={props.agentId}
                provider={props.ttsProvider}
                value={props.ttsVoice}
                onChange={props.setTtsVoice}
                staticOptions={(TTS_VOICES[props.ttsProvider] || []).map((v) => ({
                  value: v.value, label: v.label,
                }))}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {TTS_PROVIDERS.find((p) => p.value === props.ttsProvider)?.description}
          </p>
          {props.ttsProvider !== "gpu-ai" && props.ttsProvider !== "custom" && (
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
