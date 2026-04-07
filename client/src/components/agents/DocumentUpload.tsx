import { useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FileText, Upload, Trash2, CheckCircle, Loader2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";

interface Props {
  agentId: number;
}

export default function DocumentUpload({ agentId }: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const utils = trpc.useUtils();
  const { data: documents } = trpc.agentsCrud.listDocuments.useQuery(
    { agentConfigId: agentId },
    {
      // Auto-poll every 2s when any document is still processing
      refetchInterval: (query) => {
        const docs = query.state.data as any[];
        if (!docs) return false;
        return docs.some((d: any) => d.processingStatus === "processing") ? 2000 : false;
      },
    },
  );
  const deleteMutation = trpc.agentsCrud.deleteDocument.useMutation({
    onSuccess: () => {
      toast.success("Document deleted");
      utils.agentsCrud.listDocuments.invalidate({ agentConfigId: agentId });
    },
  });

  const handleUpload = async (files: FileList) => {
    for (const file of Array.from(files)) {
      const formData = new FormData();
      formData.append("file", file);

      try {
        const res = await fetch(`/api/agents/${agentId}/documents`, {
          method: "POST",
          body: formData,
        });
        if (!res.ok) throw new Error(await res.text());
        toast.success(`Uploaded: ${file.name}`);
        utils.agentsCrud.listDocuments.invalidate({ agentConfigId: agentId });
      } catch (err) {
        toast.error(`Upload failed: ${err}`);
      }
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3 flex flex-row items-center justify-between">
        <CardTitle className="text-sm flex items-center gap-2">
          <FileText className="h-4 w-4" /> Documents (RAG)
        </CardTitle>
        <Button
          size="sm"
          variant="outline"
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload className="h-3 w-3 mr-1" /> Upload
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept=".pdf,.docx,.txt,.md,.csv,.json"
          multiple
          onChange={(e) => e.target.files && handleUpload(e.target.files)}
        />
      </CardHeader>
      <CardContent>
        {!documents || documents.length === 0 ? (
          <div
            className="border-2 border-dashed rounded-md p-6 text-center text-sm text-muted-foreground cursor-pointer hover:border-muted-foreground/50"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="h-6 w-6 mx-auto mb-2 opacity-50" />
            Drop files here or click to upload
            <p className="text-xs mt-1">PDF, DOCX, TXT, MD, CSV, JSON (max 25MB)</p>
          </div>
        ) : (
          <div className="space-y-2">
            {documents.map((doc) => (
              <div key={doc.id} className="flex items-center gap-2 text-sm rounded-md border px-3 py-2">
                {doc.processingStatus === "complete" ? (
                  <CheckCircle className="h-3.5 w-3.5 text-green-500 flex-shrink-0" />
                ) : doc.processingStatus === "processing" ? (
                  <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin flex-shrink-0" />
                ) : doc.processingStatus === "failed" ? (
                  <XCircle className="h-3.5 w-3.5 text-red-500 flex-shrink-0" />
                ) : null}
                <span className="flex-1 truncate">{doc.filename}</span>
                {doc.processingStatus === "complete" && doc.chunkCount && (
                  <span className="text-xs text-muted-foreground">{doc.chunkCount} chunks</span>
                )}
                {doc.fileSizeBytes && (
                  <span className="text-xs text-muted-foreground">
                    {(doc.fileSizeBytes / 1024).toFixed(0)}KB
                  </span>
                )}
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6"
                  onClick={() => deleteMutation.mutate({ id: doc.id })}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
