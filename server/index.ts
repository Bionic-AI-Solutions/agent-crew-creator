import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import path from "path";
import { fileURLToPath } from "url";

import { createLogger } from "./_core/logger.js";
import { createContext } from "./_core/trpc.js";
import { createAuthRouter } from "./_core/auth.js";
import { appTrpcRouter } from "./routers.js";

const log = createLogger("Server");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3000", 10);

const app = express();

// ── Middleware ───────────────────────────────────────────────────
app.use(cors({
  origin: process.env.NODE_ENV === "production"
    ? ["https://platform.baisoln.com", "https://platform.bionicaisolutions.com"]
    : true,
  credentials: true,
}));
app.use(cookieParser());
app.use(express.json({ limit: "50mb" }));

// ── Health check ────────────────────────────────────────────────
app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

// ── Auth routes ─────────────────────────────────────────────────
app.use("/api/auth", createAuthRouter());

// ── tRPC ────────────────────────────────────────────────────────
app.use(
  "/trpc",
  createExpressMiddleware({
    router: appTrpcRouter,
    createContext: ({ req, res }) => createContext({ req, res }),
  }),
);

// ── File upload endpoint (for document RAG) ─────────────────────
import multer from "multer";
import { getUserFromRequest } from "./_core/auth.js";
import { getDb } from "./db.js";
import { agentDocuments, agentConfigs, apps } from "../drizzle/platformSchema.js";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.post("/api/agents/:agentId/documents", upload.single("file"), async (req, res) => {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== "admin") {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const db = await getDb();
    if (!db) { res.status(500).json({ error: "Database not available" }); return; }

    const agentId = parseInt(req.params.agentId, 10);
    const file = req.file;
    if (!file) { res.status(400).json({ error: "No file uploaded" }); return; }

    // Validate file type
    const { documentService } = await import("./services/documentService.js");
    const validationError = documentService.validateFile(file.originalname, file.size);
    if (validationError) { res.status(400).json({ error: validationError }); return; }

    // Get agent + app for MinIO path
    const [agent] = await db.select().from(agentConfigs).where(eq(agentConfigs.id, agentId)).limit(1);
    if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
    const [appRecord] = await db.select().from(apps).where(eq(apps.id, agent.appId)).limit(1);
    if (!appRecord) { res.status(404).json({ error: "App not found" }); return; }

    const docId = randomUUID().slice(0, 8);
    const minioKey = `documents/${agent.name}/${docId}/${file.originalname}`;

    // Insert document record (status: processing)
    const [doc] = await db.insert(agentDocuments).values({
      agentConfigId: agentId,
      filename: file.originalname,
      minioKey,
      fileSizeBytes: file.size,
      contentType: file.mimetype,
      processingStatus: "processing",
    }).returning();

    // Process in background
    (async () => {
      try {
        // 1. Upload to MinIO
        try {
          const Minio = await import("minio");
          const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || "minio-tenant-hl.minio.svc.cluster.local:9000";
          const [host, portStr] = MINIO_ENDPOINT.split(":");
          const minioClient = new Minio.Client({
            endPoint: host,
            port: parseInt(portStr || "9000", 10),
            useSSL: process.env.MINIO_USE_SSL === "true",
            accessKey: process.env.MINIO_ROOT_USER || "",
            secretKey: process.env.MINIO_ROOT_PASSWORD || "",
          });
          await minioClient.putObject(appRecord.slug, minioKey, file.buffer, file.size, {
            "Content-Type": file.mimetype,
          });
          log.info("Uploaded document to MinIO", { bucket: appRecord.slug, key: minioKey });
        } catch (err) {
          log.error("MinIO upload failed — document will be processed but file not stored", { error: String(err) });
          // Continue processing text extraction even if MinIO upload fails
          // The text content is still in memory from the upload buffer
        }

        // 2. Extract text + chunk
        const text = await documentService.extractText(file.buffer, file.originalname);
        const chunks = documentService.chunkText(text);
        log.info("Document chunked", { filename: file.originalname, chunks: chunks.length });

        // 3. Create Letta passages
        const passageIds: string[] = [];
        if (agent.lettaAgentId) {
          const { lettaAdmin } = await import("./services/lettaAdmin.js");
          for (const chunk of chunks) {
            try {
              const passageId = await lettaAdmin.createPassage(agent.lettaAgentId, chunk);
              if (passageId) passageIds.push(passageId);
            } catch (err) {
              log.warn("Failed to create Letta passage", { error: String(err) });
            }
          }
        }

        // 4. Update document record
        await db.update(agentDocuments).set({
          chunkCount: chunks.length,
          lettaPassageIds: passageIds,
          processingStatus: "complete",
        }).where(eq(agentDocuments.id, doc.id));

        log.info("Document processing complete", { filename: file.originalname, chunks: chunks.length, passages: passageIds.length });
      } catch (err) {
        log.error("Document processing failed", { error: String(err) });
        await db.update(agentDocuments).set({
          processingStatus: "failed",
          error: String(err),
        }).where(eq(agentDocuments.id, doc.id));
      }
    })();

    res.json({ id: doc.id, filename: doc.filename, status: "processing" });
  } catch (err) {
    log.error("Document upload error", { error: String(err) });
    res.status(500).json({ error: "Upload failed" });
  }
});

// ── Dify reverse proxy (HTTPS → internal HTTP) ────────────────
// Dify runs as a shared service in bionic-platform namespace.
// Two proxy paths:
//   /dify/console/api/* and /dify/api/* → dify-api (backend)
//   /dify/*                             → dify-web (frontend)
// The dify-web container has CONSOLE_API_URL=/dify so the Next.js frontend
// calls /dify/console/api/... which hits this proxy.
import { createProxyMiddleware } from "http-proxy-middleware";

const DIFY_NS = "bionic-platform";
const DIFY_API_TARGET = `http://dify-api.${DIFY_NS}.svc.cluster.local:5001`;
const DIFY_WEB_TARGET = `http://dify-web.${DIFY_NS}.svc.cluster.local:3000`;

// Dify API proxy — must be registered before the web catch-all
app.use("/dify/console/api", createProxyMiddleware({
  target: DIFY_API_TARGET,
  changeOrigin: true,
  pathRewrite: { "^/dify": "" },
  on: {
    error: (err, _req, res) => {
      log.warn("Dify API proxy error", { error: String(err) });
      if (res && "status" in res) {
        (res as any).status(502).json({ error: "Dify API unavailable" });
      }
    },
  },
}));

app.use("/dify/api", createProxyMiddleware({
  target: DIFY_API_TARGET,
  changeOrigin: true,
  pathRewrite: { "^/dify": "" },
  on: {
    error: (err, _req, res) => {
      log.warn("Dify API proxy error", { error: String(err) });
      if (res && "status" in res) {
        (res as any).status(502).json({ error: "Dify API unavailable" });
      }
    },
  },
}));

app.use("/dify/v1", createProxyMiddleware({
  target: DIFY_API_TARGET,
  changeOrigin: true,
  pathRewrite: { "^/dify": "" },
  on: {
    error: (err, _req, res) => {
      log.warn("Dify API proxy error", { error: String(err) });
      if (res && "status" in res) {
        (res as any).status(502).json({ error: "Dify API unavailable" });
      }
    },
  },
}));

// ── Dify auto-login redirect ───────────────────────────────────
// When platform users click "Open Dify Editor", this endpoint logs them
// into Dify automatically and redirects to the Dify dashboard with tokens.
app.get("/dify-login", async (req, res) => {
  try {
    const difyApiUrl = `http://dify-api.${DIFY_NS}.svc.cluster.local:5001`;
    const difyEmail = process.env.DIFY_ADMIN_EMAIL || "admin@bionic.local";
    const difyPassword = process.env.DIFY_ADMIN_PASSWORD || "B10n1cD1fy!2026";
    const externalDifyUrl = process.env.DIFY_EXTERNAL_BASE_URL || "https://dify.baisoln.com";

    const loginRes = await fetch(`${difyApiUrl}/console/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: difyEmail, password: difyPassword }),
    });

    if (!loginRes.ok) {
      res.redirect(`${externalDifyUrl}/signin`);
      return;
    }

    const loginData = await loginRes.json() as any;
    const accessToken = loginData?.data?.access_token;
    const refreshToken = loginData?.data?.refresh_token;

    if (accessToken) {
      // Redirect to Dify with tokens in URL — Dify's frontend reads these and stores in localStorage
      const target = req.query.next || "/apps";
      res.redirect(`${externalDifyUrl}${target}?access_token=${accessToken}&refresh_token=${refreshToken || ""}`);
    } else {
      res.redirect(`${externalDifyUrl}/signin`);
    }
  } catch (err) {
    log.warn("Dify auto-login failed", { error: String(err) });
    const externalDifyUrl = process.env.DIFY_EXTERNAL_BASE_URL || "https://dify.baisoln.com";
    res.redirect(`${externalDifyUrl}/signin`);
  }
});

// Dify static assets — the Dify frontend references these paths without /dify prefix.
// When embedded in an iframe at /dify/*, these requests go to the platform origin.
// Forward /_next/*, /vs/* (Monaco editor), /logo/*, /embed.* to the Dify web service.
const difyStaticProxy = createProxyMiddleware({
  target: DIFY_WEB_TARGET,
  changeOrigin: true,
  on: {
    error: (err, _req, res) => {
      log.warn("Dify static proxy error", { error: String(err) });
      if (res && "status" in res) {
        (res as any).status(502).json({ error: "Dify assets unavailable" });
      }
    },
  },
});
app.use("/_next", difyStaticProxy);
app.use("/vs", difyStaticProxy);
app.use("/logo", difyStaticProxy);
app.use("/embed.js", difyStaticProxy);
app.use("/embed.min.js", difyStaticProxy);

// Dify Web UI proxy — serves the Next.js frontend
// Strip X-Frame-Options so the Dify UI can be embedded in an iframe.
app.use("/dify", createProxyMiddleware({
  target: DIFY_WEB_TARGET,
  changeOrigin: true,
  pathRewrite: { "^/dify": "" },
  ws: true,
  on: {
    proxyRes: (proxyRes) => {
      delete proxyRes.headers["x-frame-options"];
    },
    error: (err, _req, res) => {
      log.warn("Dify web proxy error", { error: String(err) });
      if (res && "status" in res) {
        (res as any).status(502).json({ error: "Dify web unavailable" });
      }
    },
  },
}));

// ── Static files (production) ───────────────────────────────────
// When running via tsx from /app/server/index.ts, __dirname is /app/server
// The built frontend is at /app/dist/public
const publicDir = path.resolve(__dirname, "..", "dist", "public");
app.use(express.static(publicDir));
app.get("*", (_req, res) => {
  const indexPath = path.join(publicDir, "index.html");
  res.sendFile(indexPath, (err) => {
    if (err) res.status(404).send("Not found");
  });
});

// ── Start ───────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  log.info(`Server running on port ${PORT}`);
});
