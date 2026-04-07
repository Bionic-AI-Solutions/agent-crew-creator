/**
 * Document text extraction and chunking for RAG.
 */
import { createLogger } from "../_core/logger.js";

const log = createLogger("DocumentService");

const SUPPORTED_EXTENSIONS = [".pdf", ".docx", ".txt", ".md", ".csv", ".json"];
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB
const CHUNK_SIZE = 1500;
const CHUNK_OVERLAP = 200;

export function isSupported(filename: string): boolean {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf("."));
  return SUPPORTED_EXTENSIONS.includes(ext);
}

export function validateFile(filename: string, size: number): string | null {
  if (!isSupported(filename)) {
    return `Unsupported file type. Supported: ${SUPPORTED_EXTENSIONS.join(", ")}`;
  }
  if (size > MAX_FILE_SIZE) {
    return `File too large (${(size / 1024 / 1024).toFixed(1)}MB). Maximum: 25MB`;
  }
  return null;
}

export async function extractText(buffer: Buffer, filename: string): Promise<string> {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf("."));

  switch (ext) {
    case ".txt":
    case ".md":
    case ".csv":
      return buffer.toString("utf-8");

    case ".json":
      return JSON.stringify(JSON.parse(buffer.toString("utf-8")), null, 2);

    case ".pdf":
      // Would use pdf-parse in production
      log.warn("PDF extraction requires pdf-parse package");
      return buffer.toString("utf-8").replace(/[^\x20-\x7E\n]/g, " ");

    case ".docx":
      // Would use mammoth in production
      log.warn("DOCX extraction requires mammoth package");
      return buffer.toString("utf-8").replace(/[^\x20-\x7E\n]/g, " ");

    default:
      return buffer.toString("utf-8");
  }
}

export function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length);
    chunks.push(text.slice(start, end));
    start += CHUNK_SIZE - CHUNK_OVERLAP;
    if (start >= text.length) break;
  }

  return chunks.filter((c) => c.trim().length > 0);
}

export const documentService = { isSupported, validateFile, extractText, chunkText };
