import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Brain, FileText, Wrench, Server, Users, Plus, Upload, Trash2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { LETTA_LLM_MODELS, AVAILABLE_CREWS } from "@shared/providerOptions";
import DocumentUpload from "./DocumentUpload";
import ToolSelector from "./ToolSelector";
import McpServerSelector from "./McpServerSelector";
import CrewSelector from "./CrewSelector";

interface Props {
  agentId: number;
  appId: number;
  lettaAgentName: string;
  setLettaAgentName: (v: string) => void;
  lettaLlmModel: string;
  setLettaLlmModel: (v: string) => void;
  lettaSystemPrompt: string;
  setLettaSystemPrompt: (v: string) => void;
}

export default function LettaSection(props: Props) {
  return (
    <div className="space-y-4">
      {/* Letta Agent Config */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Brain className="h-4 w-4" /> Letta Agent Configuration
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label className="text-xs">Letta Agent Name</Label>
            <Input
              value={props.lettaAgentName}
              onChange={(e) => props.setLettaAgentName(e.target.value)}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground mt-1">Auto-generated. Format: app-letta-uuid</p>
          </div>
          <div>
            <Label className="text-xs">LLM Model (for deep reasoning)</Label>
            <Select value={props.lettaLlmModel} onValueChange={props.setLettaLlmModel}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {LETTA_LLM_MODELS.map((m) => (
                  <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">Default: GPU deep model (Qwen 3.5 27B)</p>
          </div>
          <div>
            <Label className="text-xs">Letta System Prompt</Label>
            <Textarea
              value={props.lettaSystemPrompt}
              onChange={(e) => props.setLettaSystemPrompt(e.target.value)}
              placeholder="You are the execution arm of the voice agent. Handle tools, memory, and deep reasoning..."
              rows={5}
              className="font-mono text-xs"
            />
          </div>
        </CardContent>
      </Card>

      {/* Documents (RAG) */}
      <DocumentUpload agentId={props.agentId} />

      {/* Tools */}
      <ToolSelector agentId={props.agentId} appId={props.appId} />

      {/* MCP Servers */}
      <McpServerSelector agentId={props.agentId} appId={props.appId} />

      {/* Crews */}
      <CrewSelector agentId={props.agentId} />
    </div>
  );
}
